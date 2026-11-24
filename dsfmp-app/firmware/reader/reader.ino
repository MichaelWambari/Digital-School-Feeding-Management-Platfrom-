// ============================================================
// DSFMP NFC reader - ESP32 firmware (real hardware, PN532)
//
// The same reader as firmware/wokwi, with a real PN532 NFC reader
// in place of the demo buttons. Each card tap calls the
// record_nfc_scan database function over HTTPS and shows the
// result on the Serial Monitor and, if fitted, the LCD, LEDs and
// buzzer (HAS_DISPLAY).
//
// The PN532 runs in I2C mode (SET0 H, SET1 L), sharing SDA/SCL
// with the LCD, or in SPI mode (SET0 L, SET1 H; PN532_USE_SPI).
// A card ID typed into the Serial Monitor still counts as a tap,
// for testing without a card.
// ============================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_PN532.h>

// ---------------- Settings ----------------

// The school's Wi-Fi (2.4 GHz only).
const char *WIFI_SSID = "YOUR-WIFI-NAME";
const char *WIFI_PASSWORD = "YOUR-WIFI-PASSWORD";

// Copy both values from dsfmp-app/src/lib/supabase.ts.
const char *SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const char *SUPABASE_ANON_KEY = "YOUR-ANON-KEY";

// Must match a row in nfc_devices. The demo seed registers
// reader-jasiri-01, reader-tumaini-01, reader-upendo-01 and reader-baraka-01.
const char *DEVICE_ID = "reader-tumaini-01";

// This reader's own secret (supabase/fixes/022_reader_secrets.sql).
// Make it in the SQL Editor with select set_device_secret('<DEVICE_ID>');
// and paste it here. Leave it "" for a reader that has no secret yet.
// Once the reader has a secret in the database, taps without it are
// refused ("Reader secret").
const char *DEVICE_SECRET = "";

// true when the LCD, LEDs and buzzer are wired up. With false only the
// ESP32 and the PN532 are needed: results go to the Serial Monitor and
// the board's own LED flashes (green/red on the C3's RGB LED).
const bool HAS_DISPLAY = true;

// The LCD backpack's I2C address: usually 0x27, sometimes 0x3F.
const uint8_t LCD_ADDRESS = 0x27;

// 0 = PN532 on I2C (switches SET0 H, SET1 L),
// 1 = PN532 on SPI (switches SET0 L, SET1 H).
#define PN532_USE_SPI 1

// 1 = wait for the PN532's IRQ pin to signal a card (IRQ must be
// wired), so the ESP32 isn't kept busy asking the PN532 over and
// over. 0 = poll for a card every pass of loop() (no IRQ wire needed).
#define PN532_USE_IRQ 1

// Pins. The PN532 and the LCD share the I2C bus (SDA/SCL).
#if CONFIG_IDF_TARGET_ESP32C3
// ESP32-C3 DevKit. Avoids 2/8/9 (boot pins), 18/19 (USB)
// and 20/21 (the USB serial port).
// In SPI mode the PN532 takes 4-7, so the LCD's I2C moves to 8/9
// (both boot pins, but the LCD's pull-ups hold them high as booting
// needs).
const int I2C_SDA_PIN = PN532_USE_SPI ? 8 : 4;
const int I2C_SCL_PIN = PN532_USE_SPI ? 9 : 5;
// In SPI mode GPIO 6 is MOSI, so IRQ moves to GPIO 3.
const int PN532_IRQ_PIN = PN532_USE_SPI ? 3 : 6;
const int PN532_RST_PIN = 7;
// SPI mode reuses the same four wires.
const int PN532_SCK_PIN = 4;
const int PN532_MISO_PIN = 5;
const int PN532_MOSI_PIN = 6;
const int PN532_SS_PIN = 7;
const int GREEN_LED_PIN = 0;
const int RED_LED_PIN = 1;
const int BUZZER_PIN = 10;
const int BOARD_LED_PIN = 8;  // on-board RGB LED
const bool BOARD_LED_RGB = true;
#else
// Classic ESP32 (WROOM) DevKit.
const int I2C_SDA_PIN = 21;
const int I2C_SCL_PIN = 22;
const int PN532_IRQ_PIN = 4;
const int PN532_RST_PIN = 15;
const int PN532_SCK_PIN = 18;
const int PN532_MISO_PIN = 19;
const int PN532_MOSI_PIN = 23;
const int PN532_SS_PIN = 5;
const int GREEN_LED_PIN = 25;
const int RED_LED_PIN = 26;
const int BUZZER_PIN = 33;
const int BOARD_LED_PIN = 2;  // on-board blue LED
const bool BOARD_LED_RGB = false;
#endif

// A card left on the reader is read again and again; ignore
// repeat reads of the same card for this long.
const unsigned long REPEAT_TAP_MS = 3000;

// ------------------------------------------

LiquidCrystal_I2C lcd(LCD_ADDRESS, 16, 2);
// The LCD has no "é", so it is drawn as custom character 0.
const uint8_t E_ACUTE = 0;
uint8_t E_ACUTE_PATTERN[8] = {
  0b00010,
  0b00100,
  0b01110,
  0b10001,
  0b11111,
  0b10000,
  0b01110,
  0b00000,
};
#if PN532_USE_SPI
Adafruit_PN532 nfc(PN532_SCK_PIN, PN532_MISO_PIN, PN532_MOSI_PIN, PN532_SS_PIN);
#else
Adafruit_PN532 nfc(PN532_IRQ_PIN, PN532_RST_PIN);
#endif
String serialBuffer;
String lastCard;
unsigned long lastCardAt = 0;
bool nfcReady = false;
// IRQ mode: true while the PN532 is searching for a card, and set
// by the interrupt when the PN532 pulls IRQ low with a result.
bool nfcDetecting = false;
volatile bool nfcIrqFired = false;

void IRAM_ATTR onNfcIrq() {
  nfcIrqFired = true;
}

void setup() {
  Serial.begin(115200);
  // The C3's USB serial port reconnects after a reset; wait briefly so
  // the startup messages aren't lost.
  unsigned long serialWaitStart = millis();
  while (!Serial && millis() - serialWaitStart < 3000) delay(10);
  if (HAS_DISPLAY) {
    pinMode(GREEN_LED_PIN, OUTPUT);
    pinMode(RED_LED_PIN, OUTPUT);
  } else if (!BOARD_LED_RGB) {
    pinMode(BOARD_LED_PIN, OUTPUT);
  }

  // Set the I2C pins before the LCD and PN532 libraries start the bus.
  Wire.setPins(I2C_SDA_PIN, I2C_SCL_PIN);
  if (HAS_DISPLAY) {
    lcd.init();
    lcd.backlight();
    lcd.createChar(E_ACUTE, E_ACUTE_PATTERN);
    checkLcd();
  }

  startNfc();
  connectWifi();
  Serial.println();
  Serial.printf("Reader %s ready.\n", DEVICE_ID);
  Serial.println("Tap a card, or type a card ID and press Enter.");
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

// If the PN532 doesn't answer, the reader keeps running with card IDs
// typed into the Serial Monitor, so the rest can still be tested.
void startNfc() {
  nfc.begin();
  uint32_t version = nfc.getFirmwareVersion();
  if (!version) {
    Serial.println("PN532 not found. Check the wiring, that the switches are");
    Serial.println(PN532_USE_SPI ? "set to SPI (SET0 L, SET1 H), and power-cycle the board."
                                 : "set to I2C (SET0 H, SET1 L), and power-cycle the board.");
    Serial.println("Carrying on without NFC: type card IDs in the Serial Monitor.");
    showMessage("NFC not found", "Serial only");
    delay(2000);
    return;
  }
  nfcReady = true;
  Serial.printf("PN532 found, firmware %d.%d\n", (version >> 16) & 0xFF, (version >> 8) & 0xFF);
  nfc.SAMConfig();
#if PN532_USE_IRQ
  pinMode(PN532_IRQ_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PN532_IRQ_PIN), onNfcIrq, FALLING);
  Serial.printf("Waiting for cards on IRQ (GPIO %d).\n", PN532_IRQ_PIN);
#endif
}

// Reads a card's UID into uid. In IRQ mode this only talks to the
// PN532 once it has signalled a card; otherwise it polls briefly.
bool readUid(uint8_t *uid, uint8_t *uidLength) {
  if (!nfcReady) return false;
#if PN532_USE_IRQ
  if (!nfcDetecting) {
    // The PN532 keeps searching until a card shows up, then pulls IRQ low.
    nfcDetecting = nfc.startPassiveTargetIDDetection(PN532_MIFARE_ISO14443A);
    nfcIrqFired = false;
    return false;
  }
  // IRQ stays low until the result is read, so the level check also
  // catches a card that answered before the flag was cleared above.
  if (!nfcIrqFired && digitalRead(PN532_IRQ_PIN) == HIGH) return false;
  nfcIrqFired = false;
  nfcDetecting = false;  // search again on the next call
  return nfc.readDetectedPassiveTargetID(uid, uidLength);
#else
  // Short timeout so the Serial Monitor is still checked between reads.
  return nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, uidLength, 50);
#endif
}

// Returns the ID of a card that was just tapped, or "" if none.
String readCard() {
  uint8_t uid[7];
  uint8_t uidLength;
  if (readUid(uid, &uidLength)) {
    String card;
    for (uint8_t i = 0; i < uidLength; i++) {
      if (uid[i] < 0x10) card += "0";
      card += String(uid[i], HEX);
    }
    card.toUpperCase();

    bool repeat = card == lastCard && millis() - lastCardAt < REPEAT_TAP_MS;
    lastCard = card;
    lastCardAt = millis();
    if (!repeat) return card;
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
  bool linked = false;
  unsigned long started = millis();
  bool ok = recordScan(card, firstName, error, linked);
  unsigned long elapsed = millis() - started;

  if (ok && linked) {
    // A coordinator was linking this card to a student (fix 024).
    Serial.printf("LINKED to %s (%lu ms)\n", firstName.c_str(), elapsed);
    showMessage("Card linked", firstName);
    feedback(true);
  } else if (ok) {
    Serial.printf("OK: %s (%lu ms)\n", firstName.c_str(), elapsed);
    showWelcome(firstName);
    feedback(true);
  } else {
    Serial.printf("FAILED: %s (%lu ms)\n", error.c_str(), elapsed);
    showMessage("Not recorded", describeError(error));
    feedback(false);
  }
  delay(1500);
  // Time the repeat guard from the end of the tap, not the read.
  lastCardAt = millis();
}

// Calls record_nfc_scan. Returns true on success and sets firstName, and
// linked when the tap linked the card to a student instead of recording
// a meal; otherwise sets error to the function's error code or an
// HTTP/network one.
bool recordScan(const String &card, String &firstName, String &error, bool &linked) {
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
  body["p_mode"] = "attendance";
  if (DEVICE_SECRET[0] != '\0') body["p_device_secret"] = DEVICE_SECRET;
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
    linked = result["linked"] | false;
    return true;
  }
  error = result["error"] | "unknown_error";
  return false;
}

String describeError(const String &error) {
  if (error == "unknown_tag") return "Unknown card";
  if (error == "outside_meal_time") return "Not meal time";
  if (error == "already_recorded") return "Already served";
  if (error == "not_eligible") return "Not eligible";
  if (error == "wrong_school") return "Wrong school";
  if (error == "unregistered_or_inactive_device") return "Reader not reg.";
  if (error == "bad_device_secret") return "Reader secret";
  if (error == "card_in_use") return "Card in use";
  if (error == "inactive_school") return "School inactive";
  if (error == "network_error") return "No connection";
  return error.substring(0, 16);
}

void feedback(bool ok) {
  if (!HAS_DISPLAY) {
    boardLedFeedback(ok);
    return;
  }
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
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  // Small ESP32-C3 boards often can't join Wi-Fi at full transmit power;
  // 8.5 dBm is plenty for a router or phone in the same room.
  WiFi.setTxPower(WIFI_POWER_8_5dBm);
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
    // Every 15 s without a connection, say why and try again.
    if (millis() - started > 15000) {
      reportWifiProblem();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      WiFi.setTxPower(WIFI_POWER_8_5dBm);
      started = millis();
    }
  }
  Serial.printf(" connected, IP %s\n", WiFi.localIP().toString().c_str());
}

// Prints the Wi-Fi status and whether the network can be seen at all,
// with its signal strength and security, to tell a weak signal or a
// wrong name from a wrong password or an unsupported security mode.
void reportWifiProblem() {
  Serial.printf("\nNot connected yet (status %d). Scanning...\n", WiFi.status());
  // A scan fails while a connection attempt is running, so stop it first.
  WiFi.disconnect();
  delay(100);
  int found = WiFi.scanNetworks();
  Serial.printf("  %d networks found\n", found);
  bool seen = false;
  for (int i = 0; i < found; i++) {
    bool match = WiFi.SSID(i) == WIFI_SSID;
    seen = seen || match;
    Serial.printf("  %s \"%s\"  %d dBm  security %d  channel %d\n", match ? "*" : " ",
                  WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.encryptionType(i), WiFi.channel(i));
  }
  if (!seen) Serial.println("  The network was not seen: check the name, that it is 2.4 GHz, and the distance.");
  WiFi.scanDelete();
  Serial.print("Retrying");
}

void showIdle() {
  showMessage("DSFMP reader", "Tap card...");
}

// Without the LEDs, flash the board's own LED: green (or one long
// blink) for a recorded meal, red (or three short blinks) otherwise.
void boardLedFeedback(bool ok) {
  if (BOARD_LED_RGB) {
    if (ok) rgbLedWrite(BOARD_LED_PIN, 0, 40, 0);
    else rgbLedWrite(BOARD_LED_PIN, 40, 0, 0);
    delay(800);
    rgbLedWrite(BOARD_LED_PIN, 0, 0, 0);
    return;
  }
  int blinks = ok ? 1 : 3;
  int onMs = ok ? 800 : 150;
  for (int i = 0; i < blinks; i++) {
    digitalWrite(BOARD_LED_PIN, HIGH);
    delay(onMs);
    digitalWrite(BOARD_LED_PIN, LOW);
    delay(150);
  }
}

// Says on the Serial Monitor whether the LCD answered, and if not,
// which I2C addresses did, to tell a wiring fault from a wrong address.
void checkLcd() {
  Wire.beginTransmission(LCD_ADDRESS);
  if (Wire.endTransmission() == 0) {
    Serial.printf("LCD found at 0x%02X.\n", LCD_ADDRESS);
    return;
  }
  Serial.printf("LCD not found at 0x%02X (SDA %d, SCL %d). I2C devices found:",
                LCD_ADDRESS, I2C_SDA_PIN, I2C_SCL_PIN);
  bool any = false;
  for (uint8_t address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      Serial.printf(" 0x%02X", address);
      any = true;
    }
  }
  Serial.println(any ? "" : " none - check the wiring.");
}

// A recorded meal: "bon appétit," on the top line and the student's
// first name with a smiley below (names over 13 letters are cut).
void showWelcome(const String &firstName) {
  if (!HAS_DISPLAY) return;
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("bon app");
  lcd.write(E_ACUTE);
  lcd.print("tit,");
  lcd.setCursor(0, 1);
  lcd.print(firstName.substring(0, 13) + " :)");
}

void showMessage(const String &line1, const String &line2) {
  if (!HAS_DISPLAY) return;
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
}
