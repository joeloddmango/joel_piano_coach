# Piano Coach

A practice coach that tells you **when a section is done**, not just how long you practiced.
Core rule: a section moves up a tempo step when you play it cleanly **3 times in a row** at the current tempo.

Plain HTML/CSS/JavaScript. No build step. Data stays on your device.

---

## 1. Put it online (free, HTTPS) with GitHub Pages

Your iPhone only allows the microphone on `https://` pages, so the app has to be hosted somewhere. GitHub Pages is free and permanent, and you can do it all in a web browser.

1. Go to **github.com** and create a free account (or sign in).
2. Click the **+** at the top right, then **New repository**.
   - Repository name: `piano-coach`
   - Choose **Public** (free Pages needs a public repo; nobody can see your practice data, only the app code).
   - Click **Create repository**.
3. On the new repo page, click the **uploading an existing file** link.
4. In Finder, open the `piano-coach` folder. Select **everything inside it** (`index.html`, `manifest.webmanifest`, `sw.js`, and the `css`, `js`, `icons`, `sounds` folders) and drag it all onto the GitHub page. Wait for the uploads to finish, then click **Commit changes**.
   - Check that `index.html` sits at the top level of the repo, not inside another folder.
5. Go to **Settings**, then **Pages** (left sidebar). Under "Branch", choose **main** and **/ (root)**, then click **Save**.
6. Wait 1–2 minutes and refresh. The page shows your address, something like
   `https://YOUR-NAME.github.io/piano-coach/`

**Updating later:** upload the changed files the same way ("Add file", then "Upload files"). They replace the old ones. Also open `sw.js` and bump `VERSION` (for example `piano-coach-v2`) so phones fetch the new version. The update shows up the second time you open the app.

## 2. Install on your iPhone

1. Open the address in **Safari** (not Chrome).
2. Tap the **Share** button (square with an arrow), then **Add to Home Screen**, then **Add**.
3. Open Piano Coach from the home screen icon. It runs full-screen and works offline.

## 3. Moving data between iPhone and Mac

Your phone and your Mac each keep their own copy of your data. To move it from one to the other:

- On the device that has your data: **Settings › Your data › Share backup** (AirDrop it to the Mac) or **Export backup** (saves to Files / Downloads).
- On the other device: **Settings › Import backup…** and pick the file. Importing **replaces** everything on that device.

Make a backup every week or two. If you ever delete the home-screen app, its data goes with it.

---

## How to test each part on your iPhone

Plug in **wired earphones** (Lightning/USB-C, or an adapter) first.

**Stage 1: Metronome** (Metronome tab)
- Tap Start. You should hear the click and see the dots pulse. Try −5/+5, the slider, and Tap (tap 4+ times).
- Try each Sound, the Subdivisions, and Accent on/off.
- Turn on Gap mode (2 bars on / 2 off). The click should drop out for 2 bars and come back on the downbeat.
- Flip the ringer switch to **silent**. The click should still play (on iOS 16.4 and later).

**Stage 2: Pieces + clean-rep coach**
- Pieces › Add piece (for example target 100, 4/4). Add a section (bars 1–8, start 60) or use **Auto-split…**
- Tap Practice. Tap **Start rep**, play, then tap **Clean** 3 times. The tempo should go 60 → 64 and the dots reset.
- Tap **Not clean** 5 times in a row. It should offer to drop about 10%.
- Add a routine item (for example "C major scale") under Pieces › Routine.

**Stage 3: Mic timing check**
- Settings › Mic timing check › **Calibrate**. Play one key with the click for 12 seconds. A typical result is 30–150 ms.
- Turn on **Listen while I play**. In a section, Start rep, play, then tap Clean. A timing card appears with a % score and a coloured note strip (amber = early, green = on time, red = late).
- If it says "Couldn't hear enough notes", raise **sensitivity**. If it detects notes you didn't play, lower it.
- With Gap mode on, the card also says whether you rushed or dragged during the silent bars.
- Turn on **Spot-check recordings**. After some clean reps, check Log › Spot-check recordings.

**Stage 4: Planner + log**
- Today › set the minutes › **Build session** › **Start session**. The top bar shows block and session timers. When a block's time is up, a banner offers **Next →** or **+3 min**.
- The Log tab shows your streak, a calendar, and each day's sections with tempo gains.

**Stage 5: Install + offline**
- Add to Home Screen (see above). Turn on Airplane Mode and open the app. It should still work, except for the mic permission prompt if one is due.

---

## Things that behave differently on iPhone Safari (and workarounds)

| Issue | What to do |
|---|---|
| **Bluetooth earbuds** add 150–300 ms of delay, and it varies. | Use wired earphones. If you must use Bluetooth, calibrate with those same earbuds each time. |
| **No earphones:** iOS may play the click through the quiet top "phone call" speaker while the mic is on, and the mic hears the click. | Use wired earphones whenever the mic check is on. |
| **Silent switch** used to mute web audio. | The app asks iOS for "playback" audio (iOS 16.4+). On older iOS, turn the ringer on. |
| **Mic permission** is sometimes asked again each time you open the home-screen app. | That's iOS behaviour. Tap Allow. Settings › Safari › Microphone › Allow reduces it. |
| **Screen sleeping:** keeping the screen awake works in Safari 16.4+. Home-screen apps only got it reliably in iOS 18.4. | If the screen still dims, set Settings › Display & Brightness › Auto-Lock to Never while you practice. |
| **Data cleanup:** Safari can delete data for websites you haven't opened in 7 days. Home-screen apps are exempt. | Install to the Home Screen, and export a backup now and then. |
| **Timing accuracy:** onset detection is good to about ±10–20 ms for clear attacks. Very soft playing, heavy pedal or fast trills are harder to hear. | Set each section's "fastest notes" (8ths, 16ths…) to match the music. Practice mf for timing checks. |
| **Screen tap noise:** tapping the phone can sound like a note. | The last 0.35 s before your tap is ignored. |

---

## For a future developer / Claude session

```
index.html            page shell + tab bar
css/style.css         all styles (colour tokens on :root)
js/app.js             UI: screens, coach view, modals, actions (data-act), settings binding
js/store.js           saved data shape (documented at top), localStorage, export/import, per-device settings
js/coach.js           clean-rep rules (streak → tempo up, daily goal, mastered, drop suggestion), log, streak
js/metronome.js       Web Audio lookahead scheduler, synthesized sounds, voice samples, gap mode, tap tempo
js/audio.js           shared AudioContext, iOS unlock, navigator.audioSession
js/mic.js             getUserMedia (EC/NS/AGC off) + AudioWorklet hookup
js/onset-worklet.js   onset detection on the audio thread (high-passed energy rise)
js/timing.js          onset vs. grid analysis, gap-mode drift, latency calibration maths
js/recorder.js        MediaRecorder spot-checks in IndexedDB
js/planner.js         session builder (warm-up + priority-ranked sections)
sw.js                 offline cache (bump VERSION on every release)
sounds/*.wav          spoken counts "one".."twelve" (generated with macOS `say`)
```

Ideas planned for later, with hooks already in place:
- **Touch evenness meter:** every detected note already carries its loudness (`notes[i].db` in `timing.js` results). Plot the spread per rep.
- **Piece readiness test:** play all sections in a row at target tempo. You could build it from `coach.js` `recordRep` plus a new "run-through" mode.

Run locally on a Mac: `python3 -m http.server 8765` inside this folder, then open http://localhost:8765. Opening `index.html` directly from Finder won't work, because browsers block this kind of script (modules) on `file://` pages.
