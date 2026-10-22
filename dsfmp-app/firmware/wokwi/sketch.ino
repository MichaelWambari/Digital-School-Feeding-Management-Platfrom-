// ============================================================
// DSFMP NFC reader - ESP32 firmware (Wokwi simulation)
//
// Runs on a real ESP32 or in the Wokwi simulator (wokwi.com).
// Each card tap calls the record_nfc_scan database function over
// HTTPS, the same request scripts/simulate-reader.mjs sends, and
// shows the result on the LCD, LEDs and buzzer.
//
// Wokwi has no NFC reader part, so a card tap is simulated:
//   - press a button (each one is a demo card), or
//   - type any card ID in the Serial Monitor and press Enter.
// Only readCard() needs to change for a real RC522 reader.
// ============================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <LiquidCrystal_I2C.h>

// ---------------- Settings ----------------

// Wokwi's simulated Wi-Fi. On a real board, use the school's network.
const char *WIFI_SSID = "Wokwi-GUEST";
const char *WIFI_PASSWORD = "";

// Copy both values from dsfmp-app/src/lib/supabase.ts.
const char *SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const char *SUPABASE_ANON_KEY = "YOUR-ANON-KEY";

// Must match a row in nfc_devices. The demo seed registers
// reader-jasiri-01, reader-tumaini-01, reader-upendo-01 and reader-baraka-01.
const char *DEVICE_ID = "reader-tumaini-01";

// "attendance", or "distribution" with ITEM_ID set to an inventory_items.item_id
// from the reader's school and QUANTITY to the amount issued per tap.
const char *MODE = "attendance";
const char *ITEM_ID = "";
const float QUANTITY = 1;

// Demo cards, one per button (card IDs from the demo seed; the last is unknown).
const int BUTTON_PINS[] = {13, 14, 27};
const char *BUTTON_CARDS[] = {"A1000001", "A1000002", "FFFFFFFF"};
const int BUTTON_COUNT = sizeof(BUTTON_PINS) / sizeof(BUTTON_PINS[0]);

const int GREEN_LED_PIN = 25;
const int RED_LED_PIN = 26;
const int BUZZER_PIN = 33;

// ------------------------------------------

LiquidCrystal_I2C lcd(0x27, 16, 2);
String serialBuffer;
bool lastButtonState[BUTTON_COUNT];

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < BUTTON_COUNT; i++) {
    pinMode(BUTTON_PINS[i], INPUT_PULLUP);
    lastButtonState[i] = HIGH;
  }
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(RED_LED_PIN, OUTPUT);

  lcd.init();
  lcd.backlight();

  connectWifi();
  Serial.println();
  Serial.printf("Reader %s ready, mode %s.\n", DEVICE_ID, MODE);
  Serial.println("Press a card button, or type a card ID and press Enter.");
  showIdle();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();

  String card = readCard();
  if (card.length() > 0) {
    handleTap(card);
    showIdle();
  }
}

// Returns the ID of a card that was just tapped, or "" if none.
// With an RC522 this becomes: if a new card is present, read its UID
// and return it as hex (e.g. "04A23B1C").
String readCard() {
  for (int i = 0; i < BUTTON_COUNT; i++) {
    bool state = digitalRead(BUTTON_PINS[i]);
    bool pressed = lastButtonState[i] == HIGH && state == LOW;
    lastButtonState[i] = state;
    if (pressed) {
      delay(30); // debounce
      return BUTTON_CARDS[i];
    }
  }

  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r' || c == '\n') {
      String card = serialBuffer;
      serialBuffer = "";
      card.trim();
      if (card.length() > 0) return card;
    } else {
      serialBuffer += c;
    }
  }
  return "";
}

void handleTap(const String &card) {
  Serial.printf("\nCard %s tapped\n", card.c_str());
  showMessage("Card read", card);

  String firstName, error;
  unsigned long started = millis();
  bool ok = recordScan(card, firstName, error);
  unsigned long elapsed = millis() - started;

  if (ok) {
    Serial.printf("OK: %s (%lu ms)\n", firstName.c_str(), elapsed);
    showMessage(strcmp(MODE, "distribution") == 0 ? "Food issued" : "Welcome", firstName);
    feedback(true);
  } else {
    Serial.printf("FAILED: %s (%lu ms)\n", error.c_str(), elapsed);
    showMessage("Not recorded", describeError(error));
    feedback(false);
  }
  delay(1500);
}

// Calls record_nfc_scan. Returns true on success and sets firstName;
// otherwise sets error to the function's error code or an HTTP/network one.
bool recordScan(const String &card, String &firstName, String &error) {
  WiFiClientSecure client;
  // Skips certificate checks to keep the demo simple. A deployed reader
  // should pin Supabase's root certificate with client.setCACert().
  client.setInsecure();

  HTTPClient http;
  http.begin(client, String(SUPABASE_URL) + "/rest/v1/rpc/record_nfc_scan");
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);

  JsonDocument body;
  body["p_nfc_tag_id"] = card;
  body["p_device_id"] = DEVICE_ID;
  body["p_mode"] = MODE;
  body["p_quantity"] = QUANTITY;
  if (strlen(ITEM_ID) > 0) body["p_item_id"] = ITEM_ID;
  String payload;
  serializeJson(body, payload);

  int status = http.POST(payload);
  String response = http.getString();
  http.end();

  if (status <= 0) {
    error = "network_error";
    return false;
  }
  if (status != 200) {
    error = "http_" + String(status);
    Serial.println(response);
    return false;
  }

  JsonDocument result;
  if (deserializeJson(result, response)) {
    error = "bad_response";
    return false;
  }
  if (result["success"] | false) {
    firstName = result["first_name"] | "";
    return true;
  }
  error = result["error"] | "unknown_error";
  return false;
}

String describeError(const String &error) {
  if (error == "unknown_tag") return "Unknown card";
  if (error == "outside_meal_time") return "Not meal time";
  if (error == "not_eligible") return "Not eligible";
  if (error == "wrong_school") return "Wrong school";
  if (error == "unregistered_or_inactive_device") return "Reader not reg.";
  if (error == "inactive_school") return "School inactive";
  if (error == "insufficient_stock") return "Out of stock";
  if (error == "invalid_distribution") return "Check item ID";
  if (error == "network_error") return "No connection";
  return error.substring(0, 16);
}

void feedback(bool ok) {
  int led = ok ? GREEN_LED_PIN : RED_LED_PIN;
  digitalWrite(led, HIGH);
  if (ok) {
    tone(BUZZER_PIN, 2000, 150);
  } else {
    tone(BUZZER_PIN, 400, 150);
    delay(200);
    tone(BUZZER_PIN, 400, 150);
  }
  delay(600);
  digitalWrite(led, LOW);
}

void connectWifi() {
  showMessage("Connecting WiFi", WIFI_SSID);
  Serial.printf("Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
  }
  Serial.printf(" connected, IP %s\n", WiFi.localIP().toString().c_str());
}

void showIdle() {
  showMessage("DSFMP reader", "Tap card...");
}

void showMessage(const String &line1, const String &line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
}
