const fs = require('fs');
const path = require('path');

const testFiles = ['test01', 'test03', 'test07', 'test10'];
const testLabels = { test01: '1회', test03: '3회', test07: '7회', test10: '10회' };

function parseFile(filename) {
  const content = fs.readFileSync(path.join(__dirname, 'doc', filename + '.md'), 'utf-8');
  const lines = content.split('\n');
  const allSets = [];

  // Step 1: Find all passage-based question set headers and their line positions
  const passageHeaders = [];
  for (let i = 0; i < lines.length; i++) {
    // Match various header formats:
    // "Questions 131-134 refer to the following..."
    // "### Questions 153-155: Memorandum..."
    // "Questions 181-185 (Fax and E-mail)"
    const m = lines[i].match(/[Qq]uestions?\s+(\d+)\s*[-\u2013]\s*(\d+)/i);
    if (m) {
      const startQ = parseInt(m[1]);
      if (startQ >= 131) {
        passageHeaders.push({ line: i, start: startQ, end: parseInt(m[2]) });
      }
    }
  }

  // Step 2: Find Part 5 standalone questions (101-130)
  // They are between "## PART 5" sections and before "## PART 6"
  let part6Start = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^##\s*PART\s*6/i) || (passageHeaders.length > 0 && i === passageHeaders[0].line)) {
      part6Start = i;
      break;
    }
  }

  // Parse standalone questions from Part 5 area
  const standaloneQuestions = parseStandaloneQuestions(lines.slice(0, part6Start).join('\n'));
  for (const q of standaloneQuestions) {
    allSets.push({ type: 'standalone', questions: [q] });
  }

  // Step 3: Parse passage-based question sets
  for (let h = 0; h < passageHeaders.length; h++) {
    const header = passageHeaders[h];
    const nextHeaderLine = h + 1 < passageHeaders.length ? passageHeaders[h + 1].line : lines.length;
    const sectionLines = lines.slice(header.line + 1, nextHeaderLine);
    const sectionText = sectionLines.join('\n');

    // Extract passage and translation
    const { passage, passageTranslation } = extractPassageAndTranslation(sectionText);

    // Extract individual questions
    const questions = [];
    for (let qNum = header.start; qNum <= header.end; qNum++) {
      const q = extractQuestionFromText(sectionText, qNum);
      if (q) {
        q.passageId = `${filename}_${header.start}_${header.end}`;
        questions.push(q);
      } else {
        console.warn(`  WARNING: Could not extract Q${qNum} from ${filename}`);
      }
    }

    allSets.push({
      type: 'passage',
      passage,
      passageTranslation,
      questions
    });
  }

  // Step 4: Find orphan questions in gaps between passage headers
  const capturedNums = new Set();
  allSets.forEach(s => s.questions.forEach(q => capturedNums.add(q.num)));

  for (let h = 0; h < passageHeaders.length; h++) {
    const header = passageHeaders[h];
    const nextHeader = passageHeaders[h + 1];
    if (!nextHeader) continue;

    // Check for gap between headers
    const gapStart = header.end + 1;
    const gapEnd = nextHeader.start - 1;
    if (gapEnd < gapStart) continue;

    // Look for orphan questions in the gap
    const gapLines = lines.slice(header.line, nextHeader.line);
    const gapText = gapLines.join('\n');

    const orphanQuestions = [];
    for (let qNum = gapStart; qNum <= gapEnd; qNum++) {
      if (capturedNums.has(qNum)) continue;
      const q = extractQuestionFromText(gapText, qNum);
      if (q) {
        q.passageId = `${filename}_orphan_${gapStart}_${gapEnd}`;
        orphanQuestions.push(q);
        capturedNums.add(qNum);
      }
    }

    if (orphanQuestions.length > 0) {
      allSets.push({
        type: 'passage',
        passage: '', // passage may be in the previous set's section
        passageTranslation: '',
        questions: orphanQuestions
      });
    }
  }

  return allSets;
}

function parseStandaloneQuestions(text) {
  const questions = [];
  const lines = text.split('\n');

  // Find each question by its number pattern
  for (let qNum = 101; qNum <= 130; qNum++) {
    // Find the line that starts this question
    let qStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(new RegExp('^' + qNum + '\\.\\s+'))) {
        qStart = i;
        break;
      }
    }
    if (qStart === -1) continue;

    // Find the end of this question block (next question number or --- or ## PART)
    let qEnd = lines.length;
    for (let i = qStart + 1; i < lines.length; i++) {
      const nextQMatch = lines[i].match(/^(\d{3})\.\s+/);
      if (nextQMatch && parseInt(nextQMatch[1]) > qNum) {
        qEnd = i;
        break;
      }
      if (lines[i].match(/^##\s*PART/i)) {
        qEnd = i;
        break;
      }
    }

    const block = lines.slice(qStart, qEnd).join('\n');
    const questionText = lines[qStart].replace(new RegExp('^' + qNum + '\\.\\s+'), '').replace(/\*\*/g, '').trim();

    const choices = extractChoicesFromText(block);
    const answer = extractAnswerFromText(block);
    const explanation = extractExplanationFromText(block);
    const translation = extractTranslationFromText(block);

    questions.push({
      num: qNum,
      type: 'standalone',
      question: questionText,
      choices,
      answer,
      explanation,
      translation
    });
  }

  return questions;
}

function extractPassageAndTranslation(sectionText) {
  let passage = '';
  let passageTranslation = '';

  // Find passage: from start to first [지문 해석] or first ---
  const transMarkerIdx = sectionText.indexOf('[지문 해석]');
  const firstSepIdx = sectionText.indexOf('\n---\n');

  if (transMarkerIdx !== -1) {
    // Passage is everything before [지문 해석], but we need to find the section break before it
    let passageEnd = transMarkerIdx;
    // Look for --- before the translation marker
    const lastSepBefore = sectionText.lastIndexOf('\n---\n', transMarkerIdx);
    if (lastSepBefore !== -1) {
      passageEnd = lastSepBefore;
    }
    passage = sectionText.substring(0, passageEnd).trim();

    // Translation: from after [지문 해석] to next ---
    const transStart = transMarkerIdx + '[지문 해석]'.length;
    let transEnd = sectionText.indexOf('\n---\n', transStart);
    if (transEnd === -1) transEnd = sectionText.length;
    passageTranslation = sectionText.substring(transStart, transEnd).trim();
    // Clean up markdown headers
    passageTranslation = passageTranslation.replace(/^#+\s*/gm, '').replace(/^\*\*$|^\*$/gm, '').trim();
  } else if (firstSepIdx !== -1) {
    passage = sectionText.substring(0, firstSepIdx).trim();
  } else {
    // No separator found, try to detect passage vs questions
    const lines = sectionText.split('\n');
    let passageLines = [];
    for (const line of lines) {
      if (line.match(/^\d{3}\.\s/) || line.match(/^\(A\)/) || line.match(/\*\*\d{3}\.\s/)) break;
      if (line.match(/^\*\s*\*\*정답/) || line.match(/^\*\s*\*\*해설/)) break;
      passageLines.push(line);
    }
    passage = passageLines.join('\n').trim();
  }

  // Clean passage: remove [지문 타이핑] labels and similar markers
  passage = passage
    .replace(/^#{1,3}\s*\*?\*?\[지문\s*타이핑\]\*?\*?\s*$/gm, '')
    .replace(/^\*?\*?\[지문\s*타이핑\]\*?\*?\s*$/gm, '')
    .replace(/^\*?\*?\[지문\s*해석\]\*?\*?\s*$/gm, '')
    .replace(/^\*?\*?\[문제\s*(및\s*)?해설\]\*?\*?\s*$/gm, '')
    .trim();

  // If passage contains Korean body text AND we have no translation yet,
  // check if the passage includes both English and Korean sections split by ---
  if (!passageTranslation && passage.includes('\n---\n')) {
    const parts = passage.split('\n---\n');
    if (parts.length >= 2) {
      // Check if first part is English and second is Korean
      const hasKoreanFirst = /[가-힣]{3,}/.test(parts[0]);
      const hasKoreanSecond = /[가-힣]{3,}/.test(parts[1]);
      if (!hasKoreanFirst && hasKoreanSecond) {
        passage = parts[0].trim();
        passageTranslation = parts.slice(1).join('\n---\n').trim();
      }
    }
  }

  return { passage, passageTranslation };
}

function extractQuestionFromText(sectionText, qNum) {
  // Strategy: Find the question number and extract question text, choices, answer, explanation

  // Pattern variations for question markers:
  // 1. **131. (A) text / (B) text / (C) text / (D) text**  (Part 6 fill-in)
  // 2. 131. (A) text  \n(B) text  \n(C) text  \n(D) text   (Part 6 regular)
  // 3. **147. Question text?**  \n(A)...\n(B)...\n(C)...\n(D)...  (Part 7)
  // 4. 147. Question text?\n(A)...\n(B)...\n(C)...\n(D)...  (Part 7 variant)

  const lines = sectionText.split('\n');

  // Find all lines that reference this question number
  let qLines = [];
  let collecting = false;
  let nextQNum = qNum + 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line starts with the question number
    const isQStart = line.match(new RegExp('^[\\s*]*' + qNum + '\\.' + '(?:\\s|\\*)', ''));

    if (isQStart && !collecting) {
      collecting = true;
      qLines.push(line);
      continue;
    }

    if (collecting) {
      // Stop if we hit the next question number
      const isNextQ = line.match(new RegExp('^[\\s*]*' + nextQNum + '\\.' + '(?:\\s|\\*)', ''));
      if (isNextQ) break;

      // Also stop if we hit a different question number (in case some are missing)
      const anyQ = line.match(/^[\s*]*(\d{3})\.(?:\s|\*)/);
      if (anyQ && parseInt(anyQ[1]) > qNum) break;

      // Stop at ## headers
      if (line.match(/^##\s/)) break;

      qLines.push(line);
    }
  }

  if (qLines.length === 0) {
    // Try alternative: look for the question number in context like "문제 및 해설" section
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(new RegExp('[*]*' + qNum + '\\.' + '\\s*\\(A\\)', ''))) {
        collecting = true;
        qLines.push(line);
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j];
          const isNextQ2 = nextLine.match(/^[\s*]*(\d{3})\.(?:\s|\*)/);
          if (isNextQ2 && parseInt(isNextQ2[1]) > qNum) break;
          if (nextLine.match(/^##\s/)) break;
          qLines.push(nextLine);
        }
        break;
      }
    }
  }

  if (qLines.length === 0) return null;

  const qBlock = qLines.join('\n');

  // Extract question text
  let questionText = '';
  const firstLine = qLines[0];
  const qTextMatch = firstLine.match(new RegExp('[\\s*]*' + qNum + '\\.?[\\s*]*(.*)'));
  if (qTextMatch) {
    questionText = qTextMatch[1].replace(/\*\*/g, '').trim();
  }

  // If question text starts with (A), it's a fill-in-the-blank (Part 6 style)
  if (questionText.match(/^\(A\)/)) {
    questionText = ''; // The blank is in the passage
  }

  // For multi-line question text (Part 7)
  if (questionText && !questionText.match(/\(A\)/) && !questionText.match(/정답/) && !questionText.match(/해설/)) {
    for (let j = 1; j < qLines.length; j++) {
      const nextL = qLines[j].trim();
      if (nextL.match(/^\(A\)/) || nextL.match(/^\*?\*?\(A\)/) || nextL === '' || nextL === '---') break;
      if (nextL.match(/정답|해설/)) break;
      questionText += ' ' + nextL.replace(/\*\*/g, '');
    }
    questionText = questionText.trim();
  }

  // Extract choices
  const choices = extractChoicesFromText(qBlock);

  // Extract answer
  const answer = extractAnswerFromText(qBlock);

  // Extract explanation
  const explanation = extractExplanationFromText(qBlock);

  return {
    num: qNum,
    type: 'passage',
    question: questionText,
    choices,
    answer,
    explanation
  };
}

function extractChoicesFromText(text) {
  const choices = {};

  // Strategy 1: Look for choices separated by / on one line (Part 6 fill-in style)
  // e.g., "(A) supports / (B) supported / (C) having supported / (D) would be supporting"
  const slashPattern = /\(A\)\s*(.+?)\s*\/\s*\(B\)\s*(.+?)\s*\/\s*\(C\)\s*(.+?)\s*\/\s*\(D\)\s*(.+?)(?:\*\*|\n|$)/;
  const slashMatch = text.match(slashPattern);
  if (slashMatch) {
    choices.A = slashMatch[1].replace(/\*\*/g, '').trim();
    choices.B = slashMatch[2].replace(/\*\*/g, '').trim();
    choices.C = slashMatch[3].replace(/\*\*/g, '').trim();
    choices.D = slashMatch[4].replace(/\*\*/g, '').trim();
    return choices;
  }

  // Strategy 2: Choices on separate lines
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/^\*\s*/, '').trim();

    // Match individual choice lines: (A) text or **(A) text**
    for (const letter of ['A', 'B', 'C', 'D']) {
      if (choices[letter]) continue;

      const patterns = [
        new RegExp(`^\\*?\\*?\\(${letter}\\)\\*?\\*?\\s+(.+?)(?:\\s*$)`),
        new RegExp(`\\*?\\*?\\(${letter}\\)\\*?\\*?\\s+(.+?)(?:\\s+\\*?\\*?\\([${letter === 'A' ? 'B' : letter === 'B' ? 'C' : letter === 'C' ? 'D' : 'E'}]\\)|$)`)
      ];

      for (const pat of patterns) {
        const m = trimmed.match(pat);
        if (m) {
          let val = m[1].replace(/\*\*/g, '').trim();
          // Remove trailing choices on same line
          for (const nextL of ['B', 'C', 'D']) {
            if (nextL <= letter) continue;
            const idx = val.indexOf(`(${nextL})`);
            if (idx > 0) val = val.substring(0, idx).trim();
          }
          choices[letter] = val;
          break;
        }
      }
    }

    // Also try inline: (A) text (B) text (C) text (D) text
    if (!choices.A) {
      const inline = trimmed.match(/\*?\*?\(A\)\*?\*?\s+(.+?)\s+\*?\*?\(B\)\*?\*?\s+(.+?)\s+\*?\*?\(C\)\*?\*?\s+(.+?)\s+\*?\*?\(D\)\*?\*?\s+(.+?)(?:\*\*)?$/);
      if (inline) {
        choices.A = inline[1].replace(/\*\*/g, '').trim();
        choices.B = inline[2].replace(/\*\*/g, '').trim();
        choices.C = inline[3].replace(/\*\*/g, '').trim();
        choices.D = inline[4].replace(/\*\*/g, '').trim();
      }
    }
  }

  // Strategy 3: Aggressive multi-line search
  if (!choices.A || !choices.B || !choices.C || !choices.D) {
    const allText = text.replace(/\n/g, ' ');
    for (const letter of ['A', 'B', 'C', 'D']) {
      if (choices[letter]) continue;
      const nextLetter = letter === 'A' ? 'B' : letter === 'B' ? 'C' : letter === 'C' ? 'D' : null;
      let pat;
      if (nextLetter) {
        pat = new RegExp(`\\(${letter}\\)\\s*(.+?)\\s*(?=\\(${nextLetter}\\))`, 's');
      } else {
        pat = new RegExp(`\\(${letter}\\)\\s*(.+?)\\s*(?=\\n|\\*\\*정답|\\*\\*해설|$)`, 's');
      }
      const m = allText.match(pat);
      if (m) {
        choices[letter] = m[1].replace(/\*\*/g, '').trim();
      }
    }
  }

  // Strategy 4: Insert-sentence questions with [1], [2], [3], [4] positions
  if (!choices.A && !choices.B && !choices.C && !choices.D) {
    if (text.match(/positions?\s+marked\s+\[1\]/i) || text.match(/\[1\].*\[2\].*\[3\].*\[4\]/)) {
      choices.A = '[1]';
      choices.B = '[2]';
      choices.C = '[3]';
      choices.D = '[4]';
    }
  }

  // Clean: remove any choice that contains another choice reference
  for (const letter of ['A', 'B', 'C', 'D']) {
    if (choices[letter]) {
      // Truncate at next choice marker if present
      for (const nextL of ['B', 'C', 'D']) {
        if (nextL <= letter) continue;
        const idx = choices[letter].indexOf(`(${nextL})`);
        if (idx > 0) {
          choices[letter] = choices[letter].substring(0, idx).trim();
        }
      }
      // Clean up residual markdown
      choices[letter] = choices[letter].replace(/\*\*/g, '').replace(/^\s*\*\s*/, '').trim();
    }
  }

  return choices;
}

function extractAnswerFromText(text) {
  // Pattern 1: 정답: (X) or 정답: (X) text
  let m = text.match(/정답\s*[:：]\s*\(([A-D])\)/);
  if (m) return m[1];

  // Pattern 2: [정답] (X) - new format
  m = text.match(/\[정답\]\s*\(([A-D])\)/);
  if (m) return m[1];

  // Pattern 3: 정답 (X) without colon
  m = text.match(/정답\s*\(([A-D])\)/);
  if (m) return m[1];

  // Pattern 4: Bold answer inline in choices **(X) text**
  m = text.match(/\*\*\(([A-D])\)\s+[^*]+\*\*/);
  if (m) return m[1];

  // Pattern 5: **(X)** standalone
  m = text.match(/\*\*\(([A-D])\)\*\*/);
  if (m) return m[1];

  // Pattern 6: Answer at end of choice line, bold
  m = text.match(/\*\*([A-D])\)\s/);
  if (m) return m[1];

  return '';
}

function extractExplanationFromText(text) {
  // Look for 해설 in various formats:
  // **해설:** text, * **해설:** text, **[해설]**\ntext, [해설]\ntext
  let m = text.match(/\[해설\]\s*\*?\*?\s*\n(.+?)(?=\n\s*\*?\*?\[정답\]|\n\s*\*?\*?정답|---\s*$|$)/s);
  if (!m) {
    m = text.match(/해설\s*[:：]?\s*\*?\*?\s*(.+?)(?=\n\s*\n\s*\*\s*\*?\*?해석|\n\s*\*\s*\n\s*\*?\*?해석|\n\s*\*?\*?\[?정답|\n\s*\*?\*?정답|---\s*$|$)/s);
  }
  if (m) {
    let expl = m[1].trim();
    // Clean up markdown
    expl = expl.replace(/\*\*/g, '').replace(/^\*\s*/gm, '').replace(/\n\s*\n/g, '\n').trim();
    // Remove lines that are just whitespace or bullet markers
    expl = expl.split('\n').filter(l => l.trim() && l.trim() !== '*').join('\n');
    return expl;
  }
  return '';
}

function extractTranslationFromText(text) {
  const m = text.match(/해석\s*[:：]?\s*\*?\*?\s*(.+?)(?=\n\s*\n\s*\n|---|\n##|$)/s);
  if (m) {
    let trans = m[1].trim();
    trans = trans.replace(/\*\*/g, '').replace(/^\*\s*/gm, '').trim();
    return trans;
  }
  return '';
}

// Main
const allData = {};

for (const file of testFiles) {
  console.log(`Parsing ${file}...`);
  const sets = parseFile(file);

  let totalQ = 0;
  let totalAnswered = 0;
  let missingChoices = 0;

  for (const set of sets) {
    for (const q of set.questions) {
      totalQ++;
      if (q.answer) totalAnswered++;
      if (!q.choices.A || !q.choices.B || !q.choices.C || !q.choices.D) {
        missingChoices++;
        if (totalQ <= 50 || missingChoices <= 10) {
          console.warn(`  Missing choices for Q${q.num}: A=${!!q.choices.A} B=${!!q.choices.B} C=${!!q.choices.C} D=${!!q.choices.D}`);
        }
      }
    }
  }

  console.log(`  Total: ${totalQ} questions in ${sets.length} sets, ${totalAnswered} with answers, ${missingChoices} missing choices`);

  allData[file] = {
    label: testLabels[file],
    sets,
    totalQuestions: totalQ
  };
}

// Output data.js
const jsonStr = JSON.stringify(allData);
const output = `const QUIZ_DATA = ${jsonStr};\n`;
fs.writeFileSync(path.join(__dirname, 'data.js'), output, 'utf-8');
console.log(`\nGenerated data.js (${(jsonStr.length / 1024).toFixed(1)} KB)`);
