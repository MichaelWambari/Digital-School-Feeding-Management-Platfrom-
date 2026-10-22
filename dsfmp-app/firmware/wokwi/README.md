# DSFMP reader on Wokwi

ESP32 reader firmware that runs in the [Wokwi](https://wokwi.com) simulator.
Each card tap calls `record_nfc_scan` over HTTPS (the same request as
`scripts/simulate-reader.mjs`) and shows the result on a 16x2 LCD, a green or
red LED and a buzzer.

Wokwi has no NFC reader part, so card taps are simulated: each button is a
demo card, and any card ID typed into the Serial Monitor counts as a tap.
Everything after the card read (Wi-Fi, HTTPS, the database, the display) is
real. For a real RC522 reader, only `readCard()` changes.

| Part | ESP32 pin |
|---|---|
| LCD 1602 (I2C, address 0x27) | SDA 21, SCL 22 |
| Button "Card A1000001" (Brian, Tumaini) | 13 |
| Button "Card A1000002" (Faith, Tumaini) | 14 |
| Button "Unknown card" | 27 |
| Green LED / red LED (220 Ω) | 25 / 26 |
| Buzzer | 33 |

## Run it

1. Go to [wokwi.com](https://wokwi.com), sign in, and start a new **ESP32**
   project.
2. Replace `sketch.ino` and `diagram.json` with the files in this folder.
   Add `libraries.txt` with the **+** next to the file tabs (or use the
   Library Manager tab to add **ArduinoJson** and **LiquidCrystal I2C**).
3. In `sketch.ino`, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` to the values
   in `dsfmp-app/src/lib/supabase.ts`.
4. Press **Play**. Wait for `connected` in the Serial Monitor and
   "Tap card..." on the LCD, then press a button or type a card ID and press
   Enter.

The first tap after start-up is slower while the HTTPS connection is set up.
Attendance taps only succeed during the reader's school meal windows
(Tumaini: 05:30–06:30, 12:30–14:00, 18:00–19:30 Nairobi time); at other times
the LCD shows "Not meal time". To test another school, change `DEVICE_ID`
and `BUTTON_CARDS` to cards from that school (see the demo seed).

Taps are real: they write to the database the app uses. The anon key is safe
to share (the database's RLS rules protect the data), but saved Wokwi
projects are public by default.

## Notes for the real reader

- `client.setInsecure()` skips HTTPS certificate checks to keep the demo
  simple. A deployed reader should pin Supabase's root certificate with
  `client.setCACert()`.
- If Wi-Fi is down, the tap is lost. Buffering taps offline is issue #22.
