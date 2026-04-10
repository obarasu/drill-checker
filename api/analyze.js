// /api/analyze.js - Vercel serverless function (CommonJS)
// Uses Vision API for accurate text coordinates + Gemini for grading
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64 } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

  const geminiKey = process.env.GEMINI_API_KEY;
  const visionKey = process.env.GOOGLE_TTS_API_KEY;
  if (!geminiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  if (!visionKey) return res.status(500).json({ error: 'GOOGLE_TTS_API_KEY not set' });

  const base64Data = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

  const geminiPrompt = `You are reading a Japanese elementary school math worksheet photo.
Your job is OCR only — read what is printed and handwritten. Do NOT judge correctness yourself.

Detect the problem type and handle each accordingly:

=== TYPE A: ARITHMETIC (vertical or horizontal equations) ===
Problems with a printed equation (top number, operator, bottom number) and a handwritten answer.
Operators: +, -, ×, ÷

For each problem, return:
{
  "number": 9,
  "problemType": "arithmetic",
  "operand1": 423,
  "operator": "-",
  "operand2": 276,
  "studentAnswer": 147,
  "studentAnswerStr": "147",
  "confidence": "high"
}

=== TYPE B: NON-ARITHMETIC ===
Problems that cannot be verified by calculation:
- Comparison: circle the larger number (大きい方を○で囲む)
- Ordering: write numbers in order (大きい順に番号をかく)
- Sequences: fill in the blank (□にあう数をかく)
- Word problems (文章題)
- Any other type

For each problem/blank, return:
{
  "number": 1,
  "problemType": "other",
  "problemDescription": "Circle the larger: (40, 30)",
  "correctAnswer": "40",
  "studentAnswer": "40",
  "studentAnswerStr": "40",
  "isCorrect": true,
  "confidence": "high"
}

=== RULES ===
- Return ALL problems found as a single JSON array (mix of Type A and B is fine)
- "studentAnswer": exactly what the student wrote. null if unreadable/blank.
- "studentAnswerStr": the student's answer as a string (for coordinate matching). null if unreadable/blank.
- "confidence": how confident you are in reading the student's handwritten answer. "high", "medium", or "low".
  - "high": digits are clearly legible, no ambiguity
  - "medium": mostly readable but one or more digits are ambiguous
  - "low": very hard to read, guessing
  - If blank or completely unreadable, set studentAnswer to null and confidence to "low"
- For Type A: only read numbers, do NOT calculate the answer yourself.
- For Type B: YOU determine isCorrect and correctAnswer.
- For ordering problems: treat each numbered box as a separate entry.
- For sequences: treat each blank as a separate entry.
- Order results by problem number.
- IMPORTANT: Be strict about reading handwritten digits. If you are not sure about even one digit, set confidence to "low". It is better to mark as uncertain than to guess wrong.
- DO NOT include answerBox coordinates. Coordinates are handled separately.`;

  try {
    // --- Run Vision API and Gemini API in parallel ---
    const [visionResult, geminiResult] = await Promise.all([
      callVisionAPI(visionKey, base64Data),
      callGeminiAPI(geminiKey, geminiPrompt, base64Data)
    ]);

    // --- Parse Gemini response ---
    const parts = geminiResult?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('\n');

    if (!text.trim()) {
      return res.status(422).json({ error: 'Empty response from Gemini' });
    }

    let problems;
    try {
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned);
      problems = Array.isArray(parsed) ? parsed : (parsed.problems || parsed.data || []);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return res.status(422).json({ error: 'No JSON found', raw: text.slice(0, 500) });
      problems = JSON.parse(match[0]);
    }

    // --- Extract Vision API text annotations ---
    const annotations = visionResult?.responses?.[0]?.textAnnotations || [];
    // annotations[0] is the full text, [1:] are individual words/tokens
    const wordAnnotations = annotations.slice(1);

    // Get image dimensions from fullTextAnnotation
    const fullAnno = visionResult?.responses?.[0]?.fullTextAnnotation;
    const pages = fullAnno?.pages || [];
    const imgWidth = pages[0]?.width || 0;
    const imgHeight = pages[0]?.height || 0;

    // --- Match Gemini problems with Vision API coordinates ---
    // Strategy: for each problem, find its "=" sign, then look for answer text to the right/below
    if (imgWidth && imgHeight) {
      // Find all "=" annotations
      const equalsAnns = wordAnnotations.filter(a => a.description === '=' || a.description.includes('='));

      problems.forEach(p => {
        const answerStr = p.studentAnswerStr != null ? String(p.studentAnswerStr) : (p.studentAnswer != null ? String(p.studentAnswer) : null);
        if (!answerStr) return;

        const numStr = String(p.number);
        // Find problem number annotation (e.g., "(1)", "1)", "1")
        const numAnns = wordAnnotations.filter(a => {
          const d = a.description.replace(/[()（）]/g, '').trim();
          return d === numStr;
        });

        if (numAnns.length === 0) return;

        // Get the problem number's position
        const numBox = boundingToBox(numAnns[0].boundingPoly, imgWidth, imgHeight);
        if (!numBox) return;
        const numY = (numBox[0] + numBox[2]) / 2;

        // Find the "=" sign on the same row (similar Y coordinate, within ±50)
        let bestEquals = null;
        let bestEqDist = Infinity;
        for (const eq of equalsAnns) {
          const eqBox = boundingToBox(eq.boundingPoly, imgWidth, imgHeight);
          if (!eqBox) continue;
          const eqY = (eqBox[0] + eqBox[2]) / 2;
          const yDist = Math.abs(eqY - numY);
          if (yDist < 50 && yDist < bestEqDist) {
            // Pick the "=" closest to the right of the number
            const eqX = (eqBox[1] + eqBox[3]) / 2;
            const numX = (numBox[1] + numBox[3]) / 2;
            if (eqX > numX) {
              bestEqDist = yDist;
              bestEquals = eqBox;
            }
          }
        }

        if (!bestEquals) return;
        const eqRightX = bestEquals[3]; // right edge of "="
        const eqY2 = (bestEquals[0] + bestEquals[2]) / 2;

        // Find answer text: to the right of "=", on the same row, matching answerStr
        let bestMatch = null;
        let bestDist = Infinity;

        for (const ann of wordAnnotations) {
          const box = boundingToBox(ann.boundingPoly, imgWidth, imgHeight);
          if (!box) continue;
          const annX = (box[1] + box[3]) / 2;
          const annY = (box[0] + box[2]) / 2;

          // Must be to the right of "="
          if (annX <= eqRightX) continue;
          // Must be on same row (Y within ±40)
          if (Math.abs(annY - eqY2) > 40) continue;

          // Check if this annotation matches the answer
          if (ann.description === answerStr || ann.description.includes(answerStr)) {
            const dist = annX - eqRightX; // prefer closest to "="
            if (dist < bestDist) {
              bestDist = dist;
              bestMatch = box;
            }
          }
        }

        if (bestMatch) {
          p.answerBox = bestMatch;
        }
      });
    }

    return res.status(200).json({ problems, source: 'gemini+vision' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// --- Vision API call ---
async function callVisionAPI(apiKey, base64Data) {
  const resp = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: base64Data },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
        }]
      })
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Vision API error: ${errText.slice(0, 300)}`);
  }
  return resp.json();
}

// --- Gemini API call ---
async function callGeminiAPI(apiKey, prompt, base64Data) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: base64Data } }
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } }
      })
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini error: ${errText.slice(0, 300)}`);
  }
  return resp.json();
}

// --- Find answer text in Vision API annotations ---
// Returns [y_min, x_min, y_max, x_max] in 0-1000 scale, or null
function findAnswerInAnnotations(answerStr, annotations, imgWidth, imgHeight) {
  // Strategy 1: Exact match on single annotation
  for (const ann of annotations) {
    if (ann.description === answerStr) {
      return boundingToBox(ann.boundingPoly, imgWidth, imgHeight);
    }
  }

  // Strategy 2: For multi-digit answers, try to find consecutive annotations
  // that together form the answer string
  if (answerStr.length > 1) {
    for (let i = 0; i < annotations.length; i++) {
      let combined = '';
      let startIdx = i;
      let endIdx = i;
      for (let j = i; j < annotations.length && combined.length < answerStr.length + 2; j++) {
        combined += annotations[j].description;
        endIdx = j;
        if (combined === answerStr) {
          // Merge bounding boxes from startIdx to endIdx
          return mergeBoundingBoxes(annotations.slice(startIdx, endIdx + 1), imgWidth, imgHeight);
        }
      }
    }
  }

  // Strategy 3: Partial match — annotation contains the answer
  for (const ann of annotations) {
    if (ann.description.includes(answerStr) && ann.description.length <= answerStr.length + 2) {
      return boundingToBox(ann.boundingPoly, imgWidth, imgHeight);
    }
  }

  return null;
}

// --- Assign boxes to problems that didn't get matched ---
// Use problem number as anchor: find the number in annotations,
// then look for the answer near it
function assignMissingBoxes(problems, annotations, imgWidth, imgHeight) {
  const unmatched = problems.filter(p => !p.answerBox);
  if (unmatched.length === 0) return;

  for (const p of unmatched) {
    const numStr = String(p.number);
    // Find problem number annotation
    const numAnns = annotations.filter(a => a.description === numStr || a.description === `${numStr}.` || a.description === `(${numStr})` || a.description === `${numStr})`);

    if (numAnns.length === 0) continue;

    // For each candidate number annotation, look for nearby answer text
    const answerStr = p.studentAnswerStr != null ? String(p.studentAnswerStr) : (p.studentAnswer != null ? String(p.studentAnswer) : null);
    if (!answerStr) continue;

    let bestMatch = null;
    let bestDist = Infinity;

    const numBox = boundingToBox(numAnns[0].boundingPoly, imgWidth, imgHeight);
    if (!numBox) continue;
    const numCenterY = (numBox[0] + numBox[2]) / 2;
    const numCenterX = (numBox[1] + numBox[3]) / 2;

    for (const ann of annotations) {
      if (ann.description.includes(answerStr.charAt(0)) || ann.description === answerStr) {
        const box = boundingToBox(ann.boundingPoly, imgWidth, imgHeight);
        if (!box) continue;
        const centerY = (box[0] + box[2]) / 2;
        const centerX = (box[1] + box[3]) / 2;
        // Answer should be below or to the right of the problem number
        const dist = Math.sqrt(Math.pow(centerY - numCenterY, 2) + Math.pow(centerX - numCenterX, 2));
        if (dist < bestDist && ann.description.includes(answerStr)) {
          bestDist = dist;
          bestMatch = box;
        }
      }
    }

    if (bestMatch && bestDist < 300) {
      p.answerBox = bestMatch;
    }
  }
}

// --- Convert Vision API boundingPoly to [y_min, x_min, y_max, x_max] in 0-1000 scale ---
function boundingToBox(boundingPoly, imgWidth, imgHeight) {
  if (!boundingPoly || !boundingPoly.vertices || boundingPoly.vertices.length < 4) return null;
  const vs = boundingPoly.vertices;
  const xs = vs.map(v => v.x || 0);
  const ys = vs.map(v => v.y || 0);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  return [
    Math.round((yMin / imgHeight) * 1000),
    Math.round((xMin / imgWidth) * 1000),
    Math.round((yMax / imgHeight) * 1000),
    Math.round((xMax / imgWidth) * 1000)
  ];
}

// --- Merge multiple bounding boxes into one ---
function mergeBoundingBoxes(annotations, imgWidth, imgHeight) {
  let allXs = [], allYs = [];
  for (const ann of annotations) {
    if (!ann.boundingPoly || !ann.boundingPoly.vertices) continue;
    for (const v of ann.boundingPoly.vertices) {
      allXs.push(v.x || 0);
      allYs.push(v.y || 0);
    }
  }
  if (allXs.length === 0) return null;
  return [
    Math.round((Math.min(...allYs) / imgHeight) * 1000),
    Math.round((Math.min(...allXs) / imgWidth) * 1000),
    Math.round((Math.max(...allYs) / imgHeight) * 1000),
    Math.round((Math.max(...allXs) / imgWidth) * 1000)
  ];
}
