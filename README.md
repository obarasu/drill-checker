# ドリルチェッカー (Drill Checker)

A mobile-first PWA for parents to quickly check kids' arithmetic worksheets.

## What Works

### Demo Mode (fully functional)
- Tap **デモ** to see a sample worksheet with 8 subtraction problems
- Animated scanning effect (1.5s) followed by graded results
- Each problem shows: number, expression, student's answer, and ✓ or ✗
- Wrong answers display the correct answer in blue
- Tap ✗ on a wrong answer to mark it as "checked by eye" (turns grey)

### Camera Mode (UI complete, OCR stubbed)
- Tap **カメラ** to open the device camera
- After capturing a photo, shows a "Processing..." spinner
- Displays notice: "OCR機能は準備中です" (OCR coming soon)
- Falls back to demo data for result display

### PWA
- Installable on iPhone home screen via Safari share menu
- Service worker caches assets for offline use
- Manifest with app name and theme color

## What's Stubbed

- **OCR**: The `OcrModule.analyzeWorksheetImage()` function currently returns hardcoded data. See the TODO comments in `index.html` for integration instructions.
- **Camera processing**: Images are captured and read as base64 but not sent anywhere yet.

## How to Extend with Real OCR

1. Open `index.html` and find the `OcrModule` section
2. In `analyzeWorksheetImage()`, replace the hardcoded return with an API call
3. Recommended approach: send the base64 image to GPT-4o Vision API
4. Parse the response into the expected format:

```javascript
{
  problems: [
    { number: 1, operand1: 765, operator: '-', operand2: 381, studentAnswer: 384 },
    // ...
  ]
}
```

5. The `Solver.gradeProblems()` function handles grading automatically
6. To add multiplication support, uncomment the `'*'` line in the Solver module

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main app (HTML + CSS + JS, self-contained) |
| `manifest.json` | PWA manifest for home screen install |
| `sw.js` | Service worker for offline caching |
| `README.md` | This file |

## Usage

1. Serve the directory with any static file server, or open `index.html` directly
2. On iPhone Safari, tap Share → "Add to Home Screen"
3. Launch from home screen for full-screen PWA experience

For local development:
```bash
cd /tmp/drill-checker
python3 -m http.server 8000
# Open http://localhost:8000 on your phone
```

## Tech Stack

- Pure HTML/CSS/JS — no build step, no dependencies
- PWA with service worker
- Mobile-first, optimized for iPhone 14/15 Safari
