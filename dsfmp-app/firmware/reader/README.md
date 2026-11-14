# DSFMP reader (real hardware)

ESP32 reader firmware for a real PN532 NFC reader. It is the
[Wokwi sketch](../wokwi/README.md) with the demo buttons replaced by the
PN532: each card tap calls `record_nfc_scan` over HTTPS and shows the result
on a 16x2 LCD, a green or red LED and a buzzer. A card ID typed into the
Serial Monitor still counts as a tap.

## Wiring

Set the PN532's mode switches to **I2C** (switch 1 ON, switch 2 OFF) with the
power off; they are only read at power-up. The PN532 (address 0x24) and the
LCD (0x27) share SDA and SCL.

The sketch works on a classic ESP32 (WROOM) DevKit or an ESP32-C3 DevKit and
picks the pins for the board it is compiled for.

| Part | Pin | ESP32 (WROOM) | ESP32-C3 |
|---|---|---|---|
| PN532 | SV / 5V | 3V3 | 3V3 |
| | GND | GND | GND |
| | MO/SDA/TX | 21 | 4 |
| | NSS/SCL/RX | 22 | 5 |
| | IRQ | 4 | 6 |
| | RST | 15 | 7 |
| | SCK, MI | not connected | not connected |
| LCD 1602 (I2C) | VCC / GND | 5V (or 3V3 if the backpack allows) / GND | same |
| | SDA / SCL | 21 / 22 | 4 / 5 |
| Green LED / red LED (220 Ω) | | 25 / 26 | 0 / 1 |
| Buzzer | | 33 | 10 |

In the Arduino IDE, pick **ESP32 Dev Module** for a WROOM board or
**ESP32C3 Dev Module** for a C3. A C3 board with a CP2102N USB chip needs the
Silicon Labs CP210x driver on Windows before it gets a COM port.

## Run it

1. In the Arduino IDE, install the ESP32 board package and, from the Library
   Manager, **Adafruit PN532** (with its dependencies), **ArduinoJson** and
   **LiquidCrystal I2C**.
2. Open `reader.ino`. Set `WIFI_SSID` and `WIFI_PASSWORD` (2.4 GHz networks
   only), and `SUPABASE_URL` and `SUPABASE_ANON_KEY` to the values in
   `dsfmp-app/src/lib/supabase.ts`.
3. Upload, then open the Serial Monitor at 115200 baud. It should print
   `PN532 found, firmware 1.6`, then `connected`, and the LCD shows
   "Tap card...".
4. Tap a card. The Serial Monitor prints its UID (e.g. `Card 04A23B1C
   tapped`). A new card shows "Unknown card" until that UID is set as a
   student's NFC tag ID in the app.

If the PN532 isn't found, the LCD shows "NFC not found": check the switches,
power-cycle the board, and check that SDA and SCL aren't swapped.

A card held on the reader counts as one tap; it must be taken away for
3 seconds (`REPEAT_TAP_MS`) before it counts again. Meal windows and the
HTTPS and offline notes are the same as in the [Wokwi README](../wokwi/README.md).
