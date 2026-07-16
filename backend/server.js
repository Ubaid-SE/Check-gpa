const express = require('express');
const multer = require('multer');
const cors = require('cors');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// Pakistan HEC 4.0 grading scale
const GRADE_SCALE = {
  'A+': 4.0, 'A': 4.0, 'A-': 3.7,
  'B+': 3.3, 'B': 3.0, 'B-': 2.7,
  'C+': 2.3, 'C': 2.0, 'C-': 1.7,
  'D+': 1.3, 'D': 1.0,
  'F': 0.0
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

app.post('/api/extract', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const prompt = `You are an expert at reading Pakistani university transcripts and result cards. These come in many different layouts and column-naming conventions depending on the university, so think about what each column MEANS rather than matching exact header text.

For each subject/course row, figure out and extract:
1. The subject/course name
2. The credit hours for that course
3. The letter grade earned
4. The course's contribution to GPA, if the transcript shows one directly (see reasoning below)

How to think about credit hours:
Credit hours are often written as "X(Y-Z)" — e.g. "3(3-0)" or "4(3-1)" — where X is the total credit hours and Y, Z are theory/practical splits. X should always equal Y + Z; use that as a sanity check on your own reading, since digits like "0" and "1" can look alike at small sizes. Use the outer number X as the creditHours value. Some courses (often religious/co-curricular ones) legitimately have 0 credit hours — don't assume it must be 1 just because 0 seems unusual.

How to think about the GPA-contribution column:
Many transcripts include a column related to grade points — but universities present this in two genuinely different ways, and you need to reason about which one you're looking at rather than assume:
  (a) Total quality points for that course = grade-point-value × credit-hours (e.g. a B+ in a 3-credit course might show as 9.90, or a B- in a 4-credit course as 10.80). These numbers scale up with credit hours, so a 4-credit course will show a noticeably bigger number than a 1-credit course for a similar grade.
  (b) Just the per-credit grade-point value for the letter grade (e.g. B+ = 3.30, D+ = 1.30) — this is essentially restating the grade as a number, and does NOT scale with credit hours; a 1-credit course and a 4-credit course with the same letter grade will show the identical value.
Look at the actual numbers across a few rows to tell which kind you're seeing: if the values stay roughly within 0-4.3 regardless of credit hours, it's case (b) — a per-credit grade point, not a total. In that case, multiply it by that row's credit hours yourself before reporting it, so that qualityPoints always represents the TOTAL contribution of that course (grade-point × credit-hours), never the bare per-credit value. If the values clearly scale with credit hours and go well beyond 4.3 for multi-credit courses, it's already case (a) and you can use it as-is.
This column can be labeled all sorts of things (Quality Points, QP, Q.P, GP, Grade Points, or something else) — the label alone doesn't tell you which case it is, so reason from the values themselves. Some transcripts even show BOTH columns side by side — a per-credit value AND a total (often labeled something like "QP Earned" or "Points Earned") — in that situation always use the TOTAL column for qualityPoints, since that's what actually feeds into GPA. If you genuinely can't find any such column anywhere on the transcript, that's fine — just leave qualityPoints out, the GPA will be calculated from the letter grade instead in that case.

Cross-check your reading: a per-credit grade-point value should roughly match what's expected for that letter grade (A+/A ≈ 3.7-4.0, B+ ≈ 3.0-3.5, B ≈ 2.7-3.3, B- ≈ 2.3-2.9, C+ ≈ 2.0-2.5, C ≈ 1.7-2.3, and so on down to F ≈ 0). Some universities compute this continuously from raw marks so it won't be an exact table lookup, but it should still be in the right neighborhood. If the per-credit value you calculated (quality points ÷ credit hours) is wildly inconsistent with the letter grade for that row (off by more than roughly 1 full point), treat that as a signal you may have misread either the grade or the numbers — look again at that row before finalizing.

Grade reading care:
Look closely at each grade cell — small "+" marks and similar-looking letters (like B vs D, or C+ vs D+) are easy to misread at low resolution. Grade must be one of: A+, A, A-, B+, B, B-, C+, C, C-, D+, D, F.

Return ONLY a valid JSON array, no markdown, no explanation, in this exact format:
[{"subject": "Subject Name", "creditHours": 3, "grade": "A", "qualityPoints": 10.80}]

Omit "qualityPoints" (or set it to null) for a subject if no such column exists on the transcript.
Don't split one course into multiple rows just because it has separate theory/practical columns.
If you truly cannot read something, make your best-reasoned guess from visual context rather than guessing randomly.
If no valid transcript data is found at all, return an empty array [].`;

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Image } }
          ]
        }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini API error:', data);
      return res.status(500).json({ error: 'AI extraction failed' });
    }

    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    text = text.replace(/```json|```/g, '').trim();

    let subjects;
    try {
      subjects = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: 'Could not parse extracted data. Try a clearer image.' });
    }

    res.json({ subjects, gradeScale: GRADE_SCALE });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));