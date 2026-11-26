# DSFMP reader (real hardware)

ESP32 reader firmware for a real PN532 NFC reader. It is the
[Wokwi sketch](../wokwi/README.md) with the demo buttons replaced by the
PN532: each card tap calls `record_nfc_scan` over HTTPS and shows the result
on a 16x2 LCD, a green or red LED and a buzzer. A card ID typed into the
Serial Monitor still counts as a tap.

## Wiring

The default is the full reader (`HAS_DISPLAY = true`) with the PN532 on SPI
(`PN532_USE_SPI 1`, `PN532_USE_IRQ 1`). Set the PN532's mode switches to
**SPI** (switch 1 OFF, switch 2 ON) with the power off; they are only read
at power-up.

The sketch works on a classic ESP32 (WROOM) DevKit or an ESP32-C3 DevKit and
picks the pins for the board it is compiled for.

| Part | Pin | ESP32 (WROOM) | ESP32-C3 |
|---|---|---|---|
| PN532 | VCC / GND | 5V (VIN) / GND | 5V / GND |
| | SCK | 18 | 4 |
| | MISO | 19 | 5 |
| | MOSI | 23 | 6 |
| | SS | 5 | 7 |
| | IRQ | 4 | 3 |
| | RSTO | not connected | not connected |
| LCD 1602 (I2C, 0x27) | VCC / GND | 5V / GND | 5V / GND |
| | SDA / SCL | 21 / 22 | 8 / 9 |
| Green LED (+ 220 Ω to GND) | | 25 | 0 |
| Red LED (+ 220 Ω to GND) | | 26 | 1 |
| Buzzer (+ to pin, − to GND) | | 33 | 10 |

On the C3 the LCD uses GPIO 8 and 9, which are boot pins; the LCD backpack's
pull-up resistors hold them high, which is what the C3 needs to boot. GPIO 8
also drives the C3's on-board RGB LED, which may flicker while the LCD
updates. At startup the Serial Monitor prints `LCD found at 0x27`; if not,
it lists the I2C addresses that did answer. A backpack at 0x3F needs
`LCD_ADDRESS` changed.

With the PN532 in I2C mode instead (`PN532_USE_SPI 0`, switch 1 ON, switch 2
OFF), it shares SDA and SCL with the LCD (21 / 22 on a WROOM, 4 / 5 on a C3),
with IRQ on 4 / 6.

### PN532 only (no LCD, LEDs or buzzer)

Set `HAS_DISPLAY = false` in `reader.ino`. Results go to the
Serial Monitor, and the board's own LED flashes: green or red on the C3's
RGB LED, or one long or three short blinks on a WROOM's blue LED. Power the
PN532 from **5V**, not 3V3, because its regulator needs the headroom. Its
signal pins are still 3.3 V, so they connect straight to the ESP32.

| PN532 pin | I2C (`PN532_USE_SPI 0`, SET0 H, SET1 L) | SPI (`PN532_USE_SPI 1`, SET0 L, SET1 H) | C3 / WROOM |
|---|---|---|---|
| 5V | 5V | 5V | 5V / VIN |
| GND | GND | GND | GND |
| SDA (MO) | SDA | MOSI | 4 / 21 (SPI: 6 / 23) |
| SCL (NSS) | SCL | SS | 5 / 22 (SPI: 7 / 5) |
| SCK | not connected | SCK | SPI: 4 / 18 |
| MI | not connected | MISO | SPI: 5 / 19 |
| IRQ | IRQ | IRQ | 6 / 4 (SPI: 3 / 4) |
| RST | optional | not connected | 7 / 15 |

With `PN532_USE_IRQ 1` (the default) the PN532 searches for a card by
itself and pulls **IRQ** low when it finds one, so the ESP32 only talks to
it when there is a card to read. IRQ must then be wired, or no card is ever
read. With `PN532_USE_IRQ 0` the ESP32 asks the PN532 for a card on every
pass of `loop()` instead, and IRQ can be left unconnected.

The board holds RST high by itself. The PN532's **SCK** pin is the SPI
clock, not the I2C clock: in I2C mode, use **SCL**.

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

## Offline taps

If the reader has no Wi-Fi, or a request fails on the network, it doesn't
lose the tap. It saves the card ID and the time of the tap in flash
(up to 120 taps, kept through a power cut), shows **Saved offline / Will
send later**, lights the green LED and beeps twice. While it is offline the
idle screen reads **Offline N saved**.

Wi-Fi is retried every 15 s in the background, so cards are still read
during an outage. Once it is back, the saved taps are sent one at a time,
oldest first, between card reads (**Sending N saved**). The database files
each one under the meal that was being served when it was tapped
(`supabase/fixes/029_offline_scans.sql`), so the live database needs fix
029. Until it has it, saved taps are kept and retried every minute.

Notes:

- The time comes from the internet (NTP) the first time the reader
  connects, and the ESP32 keeps it after that, also offline. A tap made
  before the clock was ever set (the reader started without Wi-Fi) is
  timed from the reader's uptime once the clock is set. If the reader
  restarts before that, the tap can't be timed and is dropped.
- Saved taps older than 3 days are refused (`stale_scan`). Sending one twice
  is harmless (`already_recorded`).
- A saved tap is not checked while offline, so the student hears the
  "saved" beep even if the card turns out to be unknown or already used.
  The result shows up on the Serial Monitor when it is sent, and unknown
  cards appear on the app's Unknown cards panel as usual.
- Saved taps never link cards; card linking needs a live connection.
