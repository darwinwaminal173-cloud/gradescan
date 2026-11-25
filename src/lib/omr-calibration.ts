// ==============================================================================
// GradeScan - Automated OMR Calibration, Benchmark & Accuracy Verification Suite
// Synthesizes Known Ground-Truth Answer Sheets & Computes Concrete Precision Metrics
// ==============================================================================

import { 
  CANONICAL_WIDTH, 
  CANONICAL_HEIGHT, 
  getCornerMarkerSpecs,
  getCornerMarkerCentroids,
  getStudentIdBubbleCoordinates, 
  getQuestionBubbleCoordinates,
  processOMRCanvas,
  gradeScannedAnswers
} from '@/lib/omr-engine';
import { Quiz, AnswerKey } from '@/types/database';

export interface CalibrationItemSpec {
  questionNumber: number;
  expectedMarked: string[];
  expectedState: 'normal' | 'light_pencil' | 'erased' | 'blank' | 'multiple';
  fillIntensity: number; // 0.0 to 1.0
  secondaryFill?: { option: string; intensity: number };
}

export interface CalibrationResultMetrics {
  totalItemsTested: number;
  overallAccuracy: number; // percentage
  cleanSheetAccuracy: number;
  rotatedSheetAccuracy: number;
  shadowedSheetAccuracy: number;
  blankDetectionAccuracy: number;
  multipleMarkAccuracy: number;
  falsePositiveRate: number; // blanks/erased falsely marked
  falseNegativeRate: number; // light marks missed as blank
  avgProcessingTimeMs: number;
  testsPassed: boolean;
  itemBreakdown: {
    questionNumber: number;
    expected: string[];
    detected: string[];
    status: 'pass' | 'fail';
    condition: string;
    confidence: number;
  }[];
}

/**
 * Creates an in-memory test answer sheet canvas with precise ground-truth markings.
 */
function synthesizeTestSheet(
  items: CalibrationItemSpec[],
  options: {
    rotationDeg?: number;
    shadowGradient?: boolean;
    optionsCount?: number;
    studentId?: string;
  } = {}
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CANONICAL_WIDTH;
  canvas.height = CANONICAL_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  const optionsCount = options.optionsCount || 4;

  // 1. White paper background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 2. Corner registration fiducials (35x35 black squares)
  const markers = getCornerMarkerSpecs();
  ctx.fillStyle = '#000000';
  ctx.fillRect(markers.topLeft.x, markers.topLeft.y, markers.topLeft.size, markers.topLeft.size);
  ctx.fillRect(markers.topRight.x, markers.topRight.y, markers.topRight.size, markers.topRight.size);
  ctx.fillRect(markers.bottomRight.x, markers.bottomRight.y, markers.bottomRight.size, markers.bottomRight.size);
  ctx.fillRect(markers.bottomLeft.x, markers.bottomLeft.y, markers.bottomLeft.size, markers.bottomLeft.size);

  // 3. Header branding and student info box
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('GradeScan Calibration Ground-Truth Test Sheet', 100, 75);

  // Draw 5-digit Student ID grid (e.g., student 12345)
  const targetId = options.studentId || '12345';
  const idCoords = getStudentIdBubbleCoordinates('student_id_5');
  for (const b of idCoords) {
    const x = b.normX * CANONICAL_WIDTH;
    const y = b.normY * CANONICAL_HEIGHT;
    const r = b.normRadius * CANONICAL_WIDTH;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    const expectedDigit = parseInt(targetId[b.digitColumn] || '0', 10);
    if (b.digitValue === expectedDigit) {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.75, 0, Math.PI * 2);
      ctx.fillStyle = '#1e293b';
      ctx.fill();
    }
  }

  // 4. Draw question bubbles and ground-truth fills
  const qCoords = getQuestionBubbleCoordinates(items.length, optionsCount);
  for (let q = 1; q <= items.length; q++) {
    const spec = items.find((it) => it.questionNumber === q);
    const bubbles = qCoords.filter((c) => c.questionNumber === q);

    for (const b of bubbles) {
      const bx = b.normX * CANONICAL_WIDTH;
      const by = b.normY * CANONICAL_HEIGHT;
      const br = b.normRadius * CANONICAL_WIDTH;

      // Draw bubble outline
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Draw light letter inside bubble
      ctx.fillStyle = '#64748b';
      ctx.font = '800 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.optionLabel, bx, by);

      if (!spec) continue;

      // Fill primary option if expected
      if (spec.expectedMarked.includes(b.optionLabel)) {
        let fillAlpha = spec.fillIntensity;
        ctx.beginPath();
        ctx.arc(bx, by, br * 0.75, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(30, 41, 59, ${fillAlpha})`;
        ctx.fill();
      }

      // Fill secondary option (e.g. for multiple marks or erased mark)
      if (spec.secondaryFill && spec.secondaryFill.option === b.optionLabel) {
        ctx.beginPath();
        ctx.arc(bx, by, br * 0.75, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(30, 41, 59, ${spec.secondaryFill.intensity})`;
        ctx.fill();
      }
    }
  }

  // 5. Apply mild shadow gradient across bottom if requested
  if (options.shadowGradient) {
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.65, 'rgba(0, 0, 0, 0.08)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // 6. Apply rotation if requested (simulates camera tilt up to 15 degrees)
  if (options.rotationDeg && options.rotationDeg !== 0) {
    const rotCanvas = document.createElement('canvas');
    // Add extra padding so corners are not clipped when rotated
    const rad = (options.rotationDeg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    rotCanvas.width = Math.round(canvas.width * cos + canvas.height * sin);
    rotCanvas.height = Math.round(canvas.width * sin + canvas.height * cos);

    const rotCtx = rotCanvas.getContext('2d')!;
    rotCtx.fillStyle = '#e2e8f0'; // Gray desk background around tilted paper
    rotCtx.fillRect(0, 0, rotCanvas.width, rotCanvas.height);

    rotCtx.save();
    rotCtx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
    rotCtx.rotate(rad);
    rotCtx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    rotCtx.restore();

    return rotCanvas;
  }

  return canvas;
}

/**
 * Standard ground-truth 20-item calibration test suite:
 * - Items 1-8: Clean solid shading (Options A..D)
 * - Items 9-11: Light pencil shading (0.24 fill)
 * - Items 12-14: Erased answers (Old option erased at 0.18, New option shaded at 0.75)
 * - Items 15-17: Blank unanswered items
 * - Items 18-19: Multiple marked items (two shaded choices)
 * - Item 20: Clean solid shading
 */
export const GROUND_TRUTH_20_ITEMS: CalibrationItemSpec[] = [
  { questionNumber: 1, expectedMarked: ['A'], expectedState: 'normal', fillIntensity: 0.90 },
  { questionNumber: 2, expectedMarked: ['B'], expectedState: 'normal', fillIntensity: 0.85 },
  { questionNumber: 3, expectedMarked: ['C'], expectedState: 'normal', fillIntensity: 0.92 },
  { questionNumber: 4, expectedMarked: ['D'], expectedState: 'normal', fillIntensity: 0.88 },
  { questionNumber: 5, expectedMarked: ['A'], expectedState: 'normal', fillIntensity: 0.95 },
  { questionNumber: 6, expectedMarked: ['B'], expectedState: 'normal', fillIntensity: 0.82 },
  { questionNumber: 7, expectedMarked: ['C'], expectedState: 'normal', fillIntensity: 0.90 },
  { questionNumber: 8, expectedMarked: ['D'], expectedState: 'normal', fillIntensity: 0.85 },
  // Light pencil marks (fill intensity ~0.26)
  { questionNumber: 9, expectedMarked: ['A'], expectedState: 'light_pencil', fillIntensity: 0.28 },
  { questionNumber: 10, expectedMarked: ['B'], expectedState: 'light_pencil', fillIntensity: 0.26 },
  { questionNumber: 11, expectedMarked: ['C'], expectedState: 'light_pencil', fillIntensity: 0.25 },
  // Erased marks: Option A has faint residual mark (0.17), Option B has strong mark (0.80)
  { questionNumber: 12, expectedMarked: ['B'], expectedState: 'erased', fillIntensity: 0.80, secondaryFill: { option: 'A', intensity: 0.17 } },
  { questionNumber: 13, expectedMarked: ['C'], expectedState: 'erased', fillIntensity: 0.78, secondaryFill: { option: 'B', intensity: 0.16 } },
  { questionNumber: 14, expectedMarked: ['D'], expectedState: 'erased', fillIntensity: 0.82, secondaryFill: { option: 'C', intensity: 0.18 } },
  // Blank questions
  { questionNumber: 15, expectedMarked: [], expectedState: 'blank', fillIntensity: 0.0 },
  { questionNumber: 16, expectedMarked: [], expectedState: 'blank', fillIntensity: 0.0 },
  { questionNumber: 17, expectedMarked: [], expectedState: 'blank', fillIntensity: 0.0 },
  // Multiple-mark items (Options A and C shaded)
  { questionNumber: 18, expectedMarked: ['A', 'C'], expectedState: 'multiple', fillIntensity: 0.75, secondaryFill: { option: 'C', intensity: 0.72 } },
  { questionNumber: 19, expectedMarked: ['B', 'D'], expectedState: 'multiple', fillIntensity: 0.80, secondaryFill: { option: 'D', intensity: 0.78 } },
  // Final item
  { questionNumber: 20, expectedMarked: ['A'], expectedState: 'normal', fillIntensity: 0.90 },
];

/**
 * Runs the complete automated OMR calibration and accuracy benchmark.
 */
export async function runCalibrationBenchmark(): Promise<CalibrationResultMetrics> {
  const startTime = performance.now();

  // Test 1: Clean Upright Sheet
  const cleanSheet = synthesizeTestSheet(GROUND_TRUTH_20_ITEMS);
  const cleanResult = await processOMRCanvas(cleanSheet, 20, 4);

  // Test 2: Rotated 8-degree Sheet (Simulates hand-held mobile capture angle)
  const rotSheet = synthesizeTestSheet(GROUND_TRUTH_20_ITEMS, { rotationDeg: 8 });
  const rotResult = await processOMRCanvas(rotSheet, 20, 4);

  // Test 3: Shadow Gradient Sheet (Simulates dim lighting or hand casting a shadow)
  const shadowSheet = synthesizeTestSheet(GROUND_TRUTH_20_ITEMS, { shadowGradient: true });
  const shadowResult = await processOMRCanvas(shadowSheet, 20, 4);

  const elapsedMs = performance.now() - startTime;
  const avgProcessingTimeMs = Math.round(elapsedMs / 3);

  // Evaluate Accuracy across tests
  let totalCorrect = 0;
  let totalItems = GROUND_TRUTH_20_ITEMS.length * 3;

  let cleanCorrect = 0;
  let rotCorrect = 0;
  let shadowCorrect = 0;

  let blankTotal = 0;
  let blankCorrect = 0;

  let multiTotal = 0;
  let multiCorrect = 0;

  let falsePositives = 0;
  let falseNegatives = 0;

  const itemBreakdown: CalibrationResultMetrics['itemBreakdown'] = [];

  // Helper evaluator
  const evaluateRun = (runResult: typeof cleanResult, condition: string, tallyCorrect: (c: number) => void) => {
    let localCorrect = 0;

    GROUND_TRUTH_20_ITEMS.forEach((spec) => {
      const detected = runResult.questions.find((q) => q.questionNumber === spec.questionNumber);
      if (!detected) return;

      const detectedSorted = [...detected.markedOptions].sort().join(',');
      const expectedSorted = [...spec.expectedMarked].sort().join(',');

      const isMatch = detectedSorted === expectedSorted;

      if (spec.expectedState === 'blank') {
        blankTotal++;
        if (detected.isBlank) blankCorrect++;
        else falsePositives++;
      } else if (spec.expectedState === 'multiple') {
        multiTotal++;
        if (detected.isMultiple) multiCorrect++;
      } else if (spec.expectedState === 'light_pencil') {
        if (detected.isBlank) falseNegatives++;
      }

      if (isMatch) {
        localCorrect++;
        totalCorrect++;
      }

      if (condition === 'Clean Upright') {
        itemBreakdown.push({
          questionNumber: spec.questionNumber,
          expected: spec.expectedMarked,
          detected: detected.markedOptions,
          status: isMatch ? 'pass' : 'fail',
          condition: spec.expectedState,
          confidence: detected.confidence,
        });
      }
    });

    tallyCorrect(localCorrect);
  };

  evaluateRun(cleanResult, 'Clean Upright', (c) => { cleanCorrect = c; });
  evaluateRun(rotResult, 'Rotated (8°)', (c) => { rotCorrect = c; });
  evaluateRun(shadowResult, 'Shadow Gradient', (c) => { shadowCorrect = c; });

  const overallAccuracy = Math.round((totalCorrect / totalItems) * 1000) / 10;
  const cleanSheetAccuracy = Math.round((cleanCorrect / GROUND_TRUTH_20_ITEMS.length) * 1000) / 10;
  const rotatedSheetAccuracy = Math.round((rotCorrect / GROUND_TRUTH_20_ITEMS.length) * 1000) / 10;
  const shadowedSheetAccuracy = Math.round((shadowCorrect / GROUND_TRUTH_20_ITEMS.length) * 1000) / 10;

  const blankDetectionAccuracy = blankTotal > 0 ? Math.round((blankCorrect / blankTotal) * 1000) / 10 : 100;
  const multipleMarkAccuracy = multiTotal > 0 ? Math.round((multiCorrect / multiTotal) * 1000) / 10 : 100;
  const falsePositiveRate = Math.round((falsePositives / Math.max(1, blankTotal)) * 1000) / 10;
  const falseNegativeRate = Math.round((falseNegatives / 3) * 1000) / 10;

  return {
    totalItemsTested: totalItems,
    overallAccuracy,
    cleanSheetAccuracy,
    rotatedSheetAccuracy,
    shadowedSheetAccuracy,
    blankDetectionAccuracy,
    multipleMarkAccuracy,
    falsePositiveRate,
    falseNegativeRate,
    avgProcessingTimeMs,
    testsPassed: overallAccuracy >= 95,
    itemBreakdown,
  };
}
