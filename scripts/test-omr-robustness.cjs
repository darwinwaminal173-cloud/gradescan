// ==============================================================================
// GradeScan Automated OMR & Camera Precision Verification Suite
// Tests: Coordinates, Homography, Rotations, Lighting, Shading, LRN, Scoring
// ==============================================================================

const fs = require('fs');
const path = require('path');

// 1. Coordinate Mathematics & Geometry Functions
const CANONICAL_WIDTH = 1000;
const CANONICAL_HEIGHT = 1414;

function getCornerMarkerSpecs() {
  const marginX = 45;
  const marginY = 45;
  const size = 35;
  return {
    topLeft: { x: marginX, y: marginY, size },
    topRight: { x: CANONICAL_WIDTH - marginX - size, y: marginY, size },
    bottomRight: { x: CANONICAL_WIDTH - marginX - size, y: CANONICAL_HEIGHT - marginY - size, size },
    bottomLeft: { x: marginX, y: CANONICAL_HEIGHT - marginY - size, size },
  };
}

function getCornerMarkerCentroids() {
  return {
    topLeft: { x: 62.5, y: 62.5 },
    topRight: { x: 937.5, y: 62.5 },
    bottomRight: { x: 937.5, y: 1351.5 },
    bottomLeft: { x: 62.5, y: 1351.5 },
  };
}

function getStudentIdBubbleCoordinates(mode = 'student_id_5') {
  const coords = [];
  if (mode === 'lrn_12') {
    const startX = 576;
    const startY = 175;
    const colSpacing = 28;
    const rowSpacing = 26;
    const radius = 7.5;
    for (let col = 0; col < 12; col++) {
      for (let digit = 0; digit <= 9; digit++) {
        coords.push({
          digitColumn: col,
          digitValue: digit,
          normX: (startX + col * colSpacing) / CANONICAL_WIDTH,
          normY: (startY + digit * rowSpacing) / CANONICAL_HEIGHT,
          normRadius: radius / CANONICAL_WIDTH,
        });
      }
    }
    return coords;
  }

  const startX = 650;
  const startY = 195;
  const colSpacing = 36;
  const rowSpacing = 28;
  const radius = 10;
  for (let col = 0; col < 5; col++) {
    for (let digit = 0; digit <= 9; digit++) {
      coords.push({
        digitColumn: col,
        digitValue: digit,
        normX: (startX + col * colSpacing) / CANONICAL_WIDTH,
        normY: (startY + digit * rowSpacing) / CANONICAL_HEIGHT,
        normRadius: radius / CANONICAL_WIDTH,
      });
    }
  }
  return coords;
}

function getQuestionBubbleCoordinates(totalQuestions, optionsCount = 4) {
  const coords = [];
  const optionLabels = ['A', 'B', 'C', 'D', 'E'].slice(0, optionsCount);
  let numColumns = 1;
  if (totalQuestions > 50) numColumns = 4;
  else if (totalQuestions > 25) numColumns = 2;

  const questionsPerCol = Math.ceil(totalQuestions / numColumns);
  const startY = 480;
  const availableWidth = CANONICAL_WIDTH - 120;
  const colWidth = availableWidth / numColumns;
  const rowHeight = Math.min(32, (CANONICAL_HEIGHT - startY - 80) / questionsPerCol);
  const bubbleSpacing = 26;
  const radius = 9;

  for (let q = 1; q <= totalQuestions; q++) {
    const colIndex = Math.floor((q - 1) / questionsPerCol);
    const rowIndex = (q - 1) % questionsPerCol;
    const colStartX = 70 + colIndex * colWidth;
    const qLabelWidth = 35;
    const bubblesStartX = colStartX + qLabelWidth + 15;
    const y = startY + rowIndex * rowHeight;

    optionLabels.forEach((label, optIdx) => {
      const x = bubblesStartX + optIdx * bubbleSpacing;
      coords.push({
        questionNumber: q,
        optionIndex: optIdx,
        optionLabel: label,
        normX: x / CANONICAL_WIDTH,
        normY: y / CANONICAL_HEIGHT,
        normRadius: radius / CANONICAL_WIDTH,
      });
    });
  }
  return coords;
}

// 2. Homography Solver
function solve8x8(A, b) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
    }
    const tmpA = A[i]; A[i] = A[maxRow]; A[maxRow] = tmpA;
    const tmpB = b[i]; b[i] = b[maxRow]; b[maxRow] = tmpB;

    const pivot = A[i][i];
    if (Math.abs(pivot) < 1e-11) return null;

    for (let k = i + 1; k < n; k++) {
      const factor = A[k][i] / pivot;
      for (let j = i; j < n; j++) {
        A[k][j] -= factor * A[i][j];
      }
      b[k] -= factor * b[i];
    }
  }

  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let j = i + 1; j < n; j++) {
      sum -= A[i][j] * x[j];
    }
    x[i] = sum / A[i][i];
  }
  return x;
}

function computeHomography(dstPts, srcPts) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const u = dstPts[i].u, v = dstPts[i].v;
    const x = srcPts[i].x, y = srcPts[i].y;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  return solve8x8(A, b);
}

// 3. Adaptive Bubble Shading Simulation
function evaluateBubbleFill(innerLumList, outerBaselineLum) {
  const meanInner = innerLumList.reduce((a, b) => a + b, 0) / (innerLumList.length || 1);
  const localDarkDelta = Math.max(22, outerBaselineLum * 0.18);
  const markThresh = Math.max(30, outerBaselineLum - localDarkDelta);

  const darkPixels = innerLumList.filter(l => l < markThresh).length;
  const darkRatio = darkPixels / (innerLumList.length || 1);
  const darknessDelta = Math.max(0, (outerBaselineLum - meanInner) / Math.max(1, outerBaselineLum));
  const fillRatio = Math.min(1.0, darkRatio * 0.65 + darknessDelta * 0.35 * 1.5);
  return { fillRatio, darkRatio, darknessDelta, meanInner, outerBaselineLum };
}

// 4. Grading Algorithm
function gradeTest(markedQuestions, answerKeys, passingPct = 75) {
  let totalScore = 0;
  let maxScore = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;

  markedQuestions.forEach(q => {
    const key = answerKeys.find(k => k.questionNumber === q.questionNumber);
    const correctOpts = key?.correctOptions || ['A'];
    const points = key?.points ?? 1;
    const isBonus = key?.isBonus ?? false;
    const isExcluded = key?.isExcluded ?? false;

    if (!isExcluded && !isBonus) maxScore += points;

    if (q.isBlank) {
      unansweredCount++;
      return;
    }

    const isCorrect = !q.isMultiple && q.marked.some(opt => correctOpts.includes(opt));
    if (isExcluded) return;

    if (isCorrect) {
      totalScore += points;
      correctCount++;
    } else {
      incorrectCount++;
    }
  });

  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : 0;
  const passed = percentage >= passingPct;
  return { totalScore, maxScore, percentage, passed, correctCount, incorrectCount, unansweredCount };
}

// ==============================================================================
// TEST RUNNER
// ==============================================================================
let passedTests = 0;
let failedTests = 0;
const resultsLog = [];

function assert(condition, testName, details = '') {
  if (condition) {
    passedTests++;
    resultsLog.push(`  ✓ PASS: ${testName} ${details ? `(${details})` : ''}`);
  } else {
    failedTests++;
    resultsLog.push(`  ✗ FAIL: ${testName} ${details ? `(${details})` : ''}`);
  }
}

console.log('\n===============================================================');
console.log(' GradeScan Automated OMR & Camera Verification Suite');
console.log('===============================================================\n');

// GROUP 1: Coordinate Synchronization
console.log('--- TEST GROUP 1: Template & Coordinate Synchronization ---');
const specs = getCornerMarkerSpecs();
const centroids = getCornerMarkerCentroids();

assert(
  centroids.topLeft.x === specs.topLeft.x + specs.topLeft.size / 2 &&
  centroids.topLeft.y === specs.topLeft.y + specs.topLeft.size / 2,
  'Top-Left corner centroid matches marker center exactly',
  `(${centroids.topLeft.x}, ${centroids.topLeft.y})`
);

assert(
  centroids.topRight.x === specs.topRight.x + specs.topRight.size / 2 &&
  centroids.topRight.y === specs.topRight.y + specs.topRight.size / 2,
  'Top-Right corner centroid matches marker center exactly',
  `(${centroids.topRight.x}, ${centroids.topRight.y})`
);

assert(
  centroids.bottomRight.x === specs.bottomRight.x + specs.bottomRight.size / 2 &&
  centroids.bottomRight.y === specs.bottomRight.y + specs.bottomRight.size / 2,
  'Bottom-Right corner centroid matches marker center exactly',
  `(${centroids.bottomRight.x}, ${centroids.bottomRight.y})`
);

assert(
  centroids.bottomLeft.x === specs.bottomLeft.x + specs.bottomLeft.size / 2 &&
  centroids.bottomLeft.y === specs.bottomLeft.y + specs.bottomLeft.size / 2,
  'Bottom-Left corner centroid matches marker center exactly',
  `(${centroids.bottomLeft.x}, ${centroids.bottomLeft.y})`
);

const id5Coords = getStudentIdBubbleCoordinates('student_id_5');
assert(id5Coords.length === 50, '5-Digit Student ID has exactly 50 bubbles (5 cols × 10 digits)');

const lrn12Coords = getStudentIdBubbleCoordinates('lrn_12');
assert(lrn12Coords.length === 120, '12-Digit LRN has exactly 120 bubbles (12 cols × 10 digits)');

const q20Coords = getQuestionBubbleCoordinates(20, 4);
assert(q20Coords.length === 80, '20 Questions × 4 choices = 80 bubble targets');

const q50Coords = getQuestionBubbleCoordinates(50, 4);
assert(q50Coords.length === 200, '50 Questions × 4 choices = 200 bubble targets');

const q100Coords = getQuestionBubbleCoordinates(100, 4);
assert(q100Coords.length === 400, '100 Questions × 4 choices = 400 bubble targets');

// GROUP 2: Homography & Paper Orientation Warp
console.log('\n--- TEST GROUP 2: Pure TS Homography & Perspective Rectification ---');
const canonicalCorners = [
  { u: 62.5, v: 62.5 },
  { u: 937.5, v: 62.5 },
  { u: 937.5, v: 1351.5 },
  { u: 62.5, v: 1351.5 }
];

// Test case 1: 0 degrees (identity-scaled)
const h0 = computeHomography(canonicalCorners, canonicalCorners);
assert(h0 !== null, 'Homography solves for upright sheet');

// Test case 2: 12 degrees rotation + shift + scale (realistic handheld portrait photo)
const angle = 12 * (Math.PI / 180);
const cos = Math.cos(angle), sin = Math.sin(angle);
const rotatedSrc = canonicalCorners.map(p => ({
  x: 80 + 0.85 * (cos * (p.u - 500) - sin * (p.v - 707) + 500),
  y: 120 + 0.85 * (sin * (p.u - 500) + cos * (p.v - 707) + 707),
}));

const hRot = computeHomography(canonicalCorners, rotatedSrc);
assert(hRot !== null, 'Homography solves for 12-degree rotated sheet');

let maxReprojErr = 0;
for (let i = 0; i < 4; i++) {
  const u = canonicalCorners[i].u, v = canonicalCorners[i].v;
  const w = hRot[6] * u + hRot[7] * v + 1;
  const px = (hRot[0] * u + hRot[1] * v + hRot[2]) / w;
  const py = (hRot[3] * u + hRot[4] * v + hRot[5]) / w;
  const err = Math.hypot(px - rotatedSrc[i].x, py - rotatedSrc[i].y);
  if (err > maxReprojErr) maxReprojErr = err;
}
assert(maxReprojErr < 1e-10, 'Homography reprojection error is near-zero float precision', `${maxReprojErr.toExponential(2)} px`);

// Test case 3: Perspective keystone distortion (phone tilted forward at 18 degrees)
const tiltedSrc = [
  { x: 120, y: 150 },   // Top-left closer to center
  { x: 880, y: 140 },   // Top-right closer to center
  { x: 990, y: 1380 },  // Bottom-right wide
  { x: 20, y: 1390 },   // Bottom-left wide
];
const hTilt = computeHomography(canonicalCorners, tiltedSrc);
assert(hTilt !== null, 'Homography solves for perspective-tilted keystone distortion');

let tiltMaxErr = 0;
for (let i = 0; i < 4; i++) {
  const u = canonicalCorners[i].u, v = canonicalCorners[i].v;
  const w = hTilt[6] * u + hTilt[7] * v + 1;
  const px = (hTilt[0] * u + hTilt[1] * v + hTilt[2]) / w;
  const py = (hTilt[3] * u + hTilt[4] * v + hTilt[5]) / w;
  const err = Math.hypot(px - tiltedSrc[i].x, py - tiltedSrc[i].y);
  if (err > tiltMaxErr) tiltMaxErr = err;
}
assert(tiltMaxErr < 1e-10, 'Perspective keystone reprojection error is near-zero', `${tiltMaxErr.toExponential(2)} px`);

// GROUP 3: Shading & Lighting Invariance
console.log('\n--- TEST GROUP 3: Shading & Lighting Invariance ---');
// Unshaded bubble in bright room (white paper lum 235, letter glyph lum 40 covers 6% of pixels)
const unshadedBright = new Array(100).fill(235);
for (let i = 0; i < 6; i++) unshadedBright[i] = 40;
const evalUnshaded = evaluateBubbleFill(unshadedBright, 235);
assert(evalUnshaded.fillRatio < 0.15, 'Blank bubble in bright room has fillRatio < 0.15', `fillRatio=${evalUnshaded.fillRatio.toFixed(3)}`);

// Shaded bubble in bright room (pencil mark lum 80 covers 85% of pixels)
const shadedBright = new Array(100).fill(235);
for (let i = 0; i < 85; i++) shadedBright[i] = 80;
const evalShadedBright = evaluateBubbleFill(shadedBright, 235);
assert(evalShadedBright.fillRatio > 0.45, 'Shaded bubble in bright room has fillRatio > 0.45', `fillRatio=${evalShadedBright.fillRatio.toFixed(3)}`);

// Unshaded bubble in dim room / shadow (paper lum 130, letter glyph lum 30)
const unshadedDim = new Array(100).fill(130);
for (let i = 0; i < 6; i++) unshadedDim[i] = 30;
const evalUnshadedDim = evaluateBubbleFill(unshadedDim, 130);
assert(evalUnshadedDim.fillRatio < 0.15, 'Blank bubble in dim shadow has fillRatio < 0.15', `fillRatio=${evalUnshadedDim.fillRatio.toFixed(3)}`);

// Shaded bubble in dim room (pencil mark lum 45 covers 85% of pixels)
const shadedDim = new Array(100).fill(130);
for (let i = 0; i < 85; i++) shadedDim[i] = 45;
const evalShadedDim = evaluateBubbleFill(shadedDim, 130);
assert(evalShadedDim.fillRatio > 0.45, 'Shaded bubble in dim shadow has fillRatio > 0.45', `fillRatio=${evalShadedDim.fillRatio.toFixed(3)}`);

// Contrast margin between shaded and unshaded under both lighting conditions
assert(
  evalShadedBright.fillRatio - evalUnshaded.fillRatio > 0.35,
  'Discrimination gap in bright lighting is > 0.35',
  `gap=${(evalShadedBright.fillRatio - evalUnshaded.fillRatio).toFixed(3)}`
);
assert(
  evalShadedDim.fillRatio - evalUnshadedDim.fillRatio > 0.35,
  'Discrimination gap in dim shadow is > 0.35',
  `gap=${(evalShadedDim.fillRatio - evalUnshadedDim.fillRatio).toFixed(3)}`
);

// GROUP 4: Blank, Single, and Multiple Marks Discrimination
console.log('\n--- TEST GROUP 4: Mark Classification Logic ---');
function classifyQuestionMarks(fillRatios) {
  // fillRatios = [A, B, C, D]
  const sorted = fillRatios.map((fill, idx) => ({ fill, label: ['A', 'B', 'C', 'D'][idx] }))
                           .sort((a, b) => b.fill - a.fill);
  const highest = sorted[0];
  const second = sorted[1];

  const isBlank = highest.fill < 0.20;
  const isMultiple = !isBlank && second.fill > 0.25 && (highest.fill - second.fill) < 0.14;
  const marked = isBlank ? [] : isMultiple ? sorted.filter(s => s.fill > 0.25).map(s => s.label) : [highest.label];
  return { isBlank, isMultiple, marked };
}

// Case 1: Option B clearly marked
const singleMark = classifyQuestionMarks([0.06, 0.72, 0.05, 0.07]);
assert(!singleMark.isBlank && !singleMark.isMultiple && singleMark.marked[0] === 'B', 'Single mark correctly identifies Option B');

// Case 2: All blank
const blankMark = classifyQuestionMarks([0.06, 0.08, 0.05, 0.07]);
assert(blankMark.isBlank && !blankMark.isMultiple && blankMark.marked.length === 0, 'Blank question correctly classified as isBlank');

// Case 3: Options A and C both shaded (multiple marks)
const doubleMark = classifyQuestionMarks([0.68, 0.05, 0.65, 0.06]);
assert(!doubleMark.isBlank && doubleMark.isMultiple && doubleMark.marked.length === 2, 'Multiple marks on A and C correctly flagged as isMultiple');

// GROUP 5: Grading & Scoring Accuracy
console.log('\n--- TEST GROUP 5: Grading & Scoring Accuracy ---');
const sampleKey = [
  { questionNumber: 1, correctOptions: ['B'], points: 1 },
  { questionNumber: 2, correctOptions: ['A'], points: 1 },
  { questionNumber: 3, correctOptions: ['C'], points: 2 }, // weighted
  { questionNumber: 4, correctOptions: ['D'], points: 1, isBonus: true }, // bonus
  { questionNumber: 5, correctOptions: ['A'], points: 1, isExcluded: true }, // excluded
];

// Student with: Q1: B (correct), Q2: B (wrong), Q3: C (correct), Q4: D (correct bonus), Q5: A (excluded)
const studentAnswers = [
  { questionNumber: 1, marked: ['B'], isBlank: false, isMultiple: false },
  { questionNumber: 2, marked: ['B'], isBlank: false, isMultiple: false },
  { questionNumber: 3, marked: ['C'], isBlank: false, isMultiple: false },
  { questionNumber: 4, marked: ['D'], isBlank: false, isMultiple: false },
  { questionNumber: 5, marked: ['A'], isBlank: false, isMultiple: false },
];

const gradeResult = gradeTest(studentAnswers, sampleKey, 75);
// Max score = Q1(1) + Q2(1) + Q3(2) = 4 points (bonus and excluded don't count towards max)
// Student score = Q1(1) + Q3(2) + Q4(bonus 1) = 4 points!
// Percentage = 4/4 * 100 = 100%
assert(gradeResult.maxScore === 4, 'Max score excludes bonus and excluded questions', `max=${gradeResult.maxScore}`);
assert(gradeResult.totalScore === 4, 'Total score awards correct + bonus questions', `score=${gradeResult.totalScore}`);
assert(gradeResult.percentage === 100 && gradeResult.passed === true, '100% score accurately marked as PASSED');

// Student with multiple mark on Q1 and blank on Q3:
const studentWithMultiple = [
  { questionNumber: 1, marked: ['A', 'B'], isBlank: false, isMultiple: true },
  { questionNumber: 2, marked: ['A'], isBlank: false, isMultiple: false },
  { questionNumber: 3, marked: [], isBlank: true, isMultiple: false },
  { questionNumber: 4, marked: ['A'], isBlank: false, isMultiple: false },
  { questionNumber: 5, marked: ['A'], isBlank: false, isMultiple: false },
];
const gradeMultipleResult = gradeTest(studentWithMultiple, sampleKey, 75);
// Q1 multiple -> 0 pts, Q2 A -> 1 pt, Q3 blank -> 0 pts, Q4 A (wrong bonus) -> 0 pts. Total = 1/4 = 25% (FAILED)
assert(gradeMultipleResult.totalScore === 1, 'Multiple mark awards 0 points', `score=${gradeMultipleResult.totalScore}`);
assert(gradeMultipleResult.unansweredCount === 1, 'Blank answer counted in unanswered tally');
assert(gradeMultipleResult.passed === false, '25% score accurately marked as FAILED');

// GROUP 6: 12-Digit LRN & 5-Digit ID Match Integrity
console.log('\n--- TEST GROUP 6: Student Identification & No-Truncation Integrity ---');
const sampleRoster = [
  { id: 'uuid-1', student_number: '10042', lrn: '109876543210', first_name: 'Juan', last_name: 'Dela Cruz' },
  { id: 'uuid-2', student_number: '10043', lrn: '109876543211', first_name: 'Maria', last_name: 'Santos' },
  { id: 'uuid-3', student_number: '00123', lrn: '012345678901', first_name: 'Pedro', last_name: 'Penduko' },
];

function matchStudent(detectedId, detectedLrn, roster) {
  const isBlankId = (!detectedId || /^0+$/.test(detectedId)) && (!detectedLrn || /^0+$/.test(detectedLrn));
  if (isBlankId) return { match: null, reason: 'blank_id' };

  let matches = [];
  if (detectedLrn && detectedLrn.length >= 10) {
    matches = roster.filter(s => s.lrn === detectedLrn || s.student_number === detectedLrn);
  }
  if (matches.length === 0 && detectedId && !/^0+$/.test(detectedId)) {
    matches = roster.filter(s => s.student_number === detectedId || s.student_number.padStart(5, '0') === detectedId || s.lrn === detectedId);
  }

  if (matches.length === 1) return { match: matches[0], reason: 'matched' };
  if (matches.length > 1) return { match: null, reason: 'ambiguous_multiple' };
  return { match: null, reason: 'not_found' };
}

// Test exact 12-digit LRN match
const lrnMatch = matchStudent('', '109876543210', sampleRoster);
assert(lrnMatch.match?.id === 'uuid-1', '12-digit LRN exact match succeeds without truncation', `student=${lrnMatch.match?.last_name}`);

// Test exact 5-digit Student ID match
const idMatch = matchStudent('10043', '', sampleRoster);
assert(idMatch.match?.id === 'uuid-2', '5-digit Student ID exact match succeeds', `student=${idMatch.match?.last_name}`);

// Test leading zeros preservation (00123)
const leadZeroMatch = matchStudent('00123', '', sampleRoster);
assert(leadZeroMatch.match?.id === 'uuid-3', 'Leading zeros in Student ID preserved and matched', `student=${leadZeroMatch.match?.last_name}`);

// Test blank ID safety (never auto-assign)
const blankMatch = matchStudent('00000', '000000000000', sampleRoster);
assert(blankMatch.match === null && blankMatch.reason === 'blank_id', 'Blank / all-zero ID correctly blocked from matching');

// Test unregistered ID safety
const unknownMatch = matchStudent('99999', '', sampleRoster);
assert(unknownMatch.match === null && unknownMatch.reason === 'not_found', 'Unregistered ID safely routed to manual review');

// ==============================================================================
// SUMMARY REPORT
// ==============================================================================
console.log('\n===============================================================');
console.log(' TEST EXECUTION SUMMARY');
console.log('===============================================================');
resultsLog.forEach(log => console.log(log));
console.log('---------------------------------------------------------------');
console.log(`Total Tests Executed: ${passedTests + failedTests}`);
console.log(`Passed:               ${passedTests}`);
console.log(`Failed:               ${failedTests}`);
const accuracyPct = Math.round((passedTests / (passedTests + failedTests)) * 100);
console.log(`Test Pass Rate:       ${accuracyPct}%`);
console.log('===============================================================\n');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
