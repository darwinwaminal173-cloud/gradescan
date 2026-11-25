// ==============================================================================
// GradeScan - Advanced Computer Vision & OMR Recognition Engine
// High-Precision Fiducial Alignment, Auto-Capture & Optical Mark Scoring
// Pure TypeScript 3x3 Projective Homography & Local-Adaptive Bubble Analysis
// ==============================================================================

import { 
  Point, 
  SheetCornerMarkers, 
  BubbleCoordinate, 
  StudentIdBubbleCoordinate, 
  BubbleDetectionResult, 
  QuestionScanResult, 
  ScannedSheetData, 
  GradingEvaluation 
} from '@/types/omr';
import { Quiz, AnswerKey } from '@/types/database';

declare global {
  interface Window {
    cv: any;
    cvReady?: boolean;
  }
}

/**
 * Checks whether the OpenCV.js WebAssembly runtime is loaded and ready.
 */
export function isOpenCvReady(): boolean {
  return typeof window !== 'undefined' && !!window.cv && typeof window.cv.Mat === 'function';
}

// Canonical rectified dimensions for standard examination sheet
export const CANONICAL_WIDTH = 1000;
export const CANONICAL_HEIGHT = 1414; // ~1:1.414 standard A4 aspect ratio

// -----------------------------------------------------------------------------
// TEMPLATE COORDINATE GENERATORS
// -----------------------------------------------------------------------------

/**
 * Returns canonical coordinates for registration corner markers.
 * Standardized 35x35 black squares centered at 45px margins from edges.
 */
export function getCornerMarkerSpecs() {
  const marginX = 45;
  const marginY = 45;
  const size = 35; // width and height of solid black square

  return {
    topLeft: { x: marginX, y: marginY, size },
    topRight: { x: CANONICAL_WIDTH - marginX - size, y: marginY, size },
    bottomRight: { x: CANONICAL_WIDTH - marginX - size, y: CANONICAL_HEIGHT - marginY - size, size },
    bottomLeft: { x: marginX, y: CANONICAL_HEIGHT - marginY - size, size },
  };
}

/**
 * Returns exact centroids of the 4 registration corner markers in canonical space.
 * Used as destination anchors for 3x3 projective homography transformation.
 */
export function getCornerMarkerCentroids(): SheetCornerMarkers {
  return {
    topLeft: { x: 62.5, y: 62.5 },
    topRight: { x: 937.5, y: 62.5 },
    bottomRight: { x: 937.5, y: 1351.5 },
    bottomLeft: { x: 62.5, y: 1351.5 },
  };
}

export type IdentifierMode = 'student_id_5' | 'lrn_12';

/**
 * Computes exact canonical coordinates of the Student ID or LRN bubble grid.
 * - 'student_id_5': 5 columns (digits 0..4) and 10 rows (values 0..9) for standard Student ID
 * - 'lrn_12': 12 columns (digits 0..11) and 10 rows (values 0..9) for 12-digit DepEd LRN
 * Exactly synchronized with sheet-generator layout.
 */
export function getStudentIdBubbleCoordinates(mode: IdentifierMode = 'student_id_5'): StudentIdBubbleCoordinate[] {
  const coords: StudentIdBubbleCoordinate[] = [];

  if (mode === 'lrn_12') {
    // 12 columns for full DepEd LRN (columns 0..11, digits 0..9)
    const startX = 576;
    const startY = 175;
    const colSpacing = 28;
    const rowSpacing = 26;
    const radius = 7.5;

    for (let col = 0; col < 12; col++) {
      for (let digit = 0; digit <= 9; digit++) {
        const x = startX + col * colSpacing;
        const y = startY + digit * rowSpacing;
        coords.push({
          digitColumn: col,
          digitValue: digit,
          normX: x / CANONICAL_WIDTH,
          normY: y / CANONICAL_HEIGHT,
          normRadius: radius / CANONICAL_WIDTH,
        });
      }
    }
    return coords;
  }

  // 5 columns for standard Student ID (columns 0..4, digits 0..9)
  const startX = 650;
  const startY = 195;
  const colSpacing = 36;
  const rowSpacing = 28;
  const radius = 10;

  for (let col = 0; col < 5; col++) {
    for (let digit = 0; digit <= 9; digit++) {
      const x = startX + col * colSpacing;
      const y = startY + digit * rowSpacing;
      coords.push({
        digitColumn: col,
        digitValue: digit,
        normX: x / CANONICAL_WIDTH,
        normY: y / CANONICAL_HEIGHT,
        normRadius: radius / CANONICAL_WIDTH,
      });
    }
  }
  return coords;
}

/**
 * Computes exact canonical coordinates for question bubbles based on quiz question count & options.
 * Generates clean multi-column layouts:
 * - <= 25 questions: 1 column
 * - 26 to 50 questions: 2 columns
 * - 51 to 100 questions: 4 columns
 */
export function getQuestionBubbleCoordinates(totalQuestions: number, optionsCount: number = 4): BubbleCoordinate[] {
  const coords: BubbleCoordinate[] = [];
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

// -----------------------------------------------------------------------------
// IMAGE QUALITY, BLUR & LIGHTING DETECTION
// -----------------------------------------------------------------------------

/**
 * Estimates image sharpness using Laplacian variance on luminance.
 * Fast algorithm (< 3ms) that prevents blurry auto-captures.
 */
export function measureSharpness(ctx: CanvasRenderingContext2D, width: number, height: number): number {
  const step = 4;
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const i = (y * width + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

      const iUp = ((y - step) * width + x) * 4;
      const iDown = ((y + step) * width + x) * 4;
      const iLeft = (y * width + (x - step)) * 4;
      const iRight = (y * width + (x + step)) * 4;

      const lumUp = 0.299 * data[iUp] + 0.587 * data[iUp + 1] + 0.114 * data[iUp + 2];
      const lumDown = 0.299 * data[iDown] + 0.587 * data[iDown + 1] + 0.114 * data[iDown + 2];
      const lumLeft = 0.299 * data[iLeft] + 0.587 * data[iLeft + 1] + 0.114 * data[iLeft + 2];
      const lumRight = 0.299 * data[iRight] + 0.587 * data[iRight + 1] + 0.114 * data[iRight + 2];

      const lap = Math.abs(4 * lum - (lumUp + lumDown + lumLeft + lumRight));
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return Math.round(variance);
}

/**
 * Evaluates illumination quality to detect poorly lit (shadows/dim) or overexposed frames.
 */
export function measureLightingQuality(ctx: CanvasRenderingContext2D, width: number, height: number): {
  avgLum: number;
  isPoorlyLit: boolean;
  isOverexposed: boolean;
  lightingQuality: 'good' | 'too_dark' | 'too_bright';
} {
  const step = 8;
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  let lumSum = 0;
  let count = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      lumSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      count++;
    }
  }

  const avgLum = lumSum / (count || 1);
  const isPoorlyLit = avgLum < 65;
  const isOverexposed = avgLum > 245;
  const lightingQuality = isPoorlyLit ? 'too_dark' : isOverexposed ? 'too_bright' : 'good';

  return { avgLum: Math.round(avgLum), isPoorlyLit, isOverexposed, lightingQuality };
}

// -----------------------------------------------------------------------------
// CORNER REGISTRATION MARKER DETECTION
// -----------------------------------------------------------------------------

interface MarkerCandidate {
  x: number;
  y: number;
  size: number;
  score: number;
}

/**
 * Attempts OpenCV-based contour fiducial detection when OpenCV.js is initialized.
 */
export function findCornersOpenCv(canvas: HTMLCanvasElement): SheetCornerMarkers | null {
  if (!isOpenCvReady()) return null;
  try {
    const cv = window.cv;
    const width = canvas.width;
    const height = canvas.height;
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const thresh = new cv.Mat();
    cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 25, 10);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const candidates: { x: number; y: number; area: number }[] = [];
    const minArea = (width * 0.015) * (width * 0.015);
    const maxArea = (width * 0.12) * (width * 0.12);

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area >= minArea && area <= maxArea) {
        const rect = cv.boundingRect(cnt);
        const aspect = rect.width / (rect.height || 1);
        if (aspect >= 0.65 && aspect <= 1.55) {
          const moments = cv.moments(cnt);
          if (moments.m00 > 0) {
            candidates.push({
              x: moments.m10 / moments.m00,
              y: moments.m01 / moments.m00,
              area,
            });
          }
        }
      }
      cnt.delete();
    }

    src.delete();
    gray.delete();
    thresh.delete();
    contours.delete();
    hierarchy.delete();

    if (candidates.length < 4) return null;

    const qW = width * 0.38;
    const qH = height * 0.38;
    const tlC = candidates.filter((c) => c.x <= qW && c.y <= qH);
    const trC = candidates.filter((c) => c.x >= width - qW && c.y <= qH);
    const brC = candidates.filter((c) => c.x >= width - qW && c.y >= height - qH);
    const blC = candidates.filter((c) => c.x <= qW && c.y >= height - qH);

    if (!tlC.length || !trC.length || !brC.length || !blC.length) {
      return null;
    }

    const tl = tlC.reduce((best, c) => Math.hypot(c.x, c.y) < Math.hypot(best.x, best.y) ? c : best);
    const tr = trC.reduce((best, c) => Math.hypot(c.x - width, c.y) < Math.hypot(best.x - width, best.y) ? c : best);
    const br = brC.reduce((best, c) => Math.hypot(c.x - width, c.y - height) < Math.hypot(best.x - width, best.y - height) ? c : best);
    const bl = blC.reduce((best, c) => Math.hypot(c.x, c.y - height) < Math.hypot(best.x, best.y - height) ? c : best);

    const corners: SheetCornerMarkers = {
      topLeft: { x: tl.x, y: tl.y },
      topRight: { x: tr.x, y: tr.y },
      bottomRight: { x: br.x, y: br.y },
      bottomLeft: { x: bl.x, y: bl.y },
    };

    return validateCornersGeometry(corners, width, height) ? corners : null;
  } catch (err) {
    console.warn('[omr-engine] OpenCV corner extraction error, falling back:', err);
    return null;
  }
}

/**
 * Validates quadrilateral geometry and topological ordering of detected corners.
 */
export function validateCornersGeometry(corners: SheetCornerMarkers, width: number, height: number): boolean {
  const { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl } = corners;

  const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const botW = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftH = Math.hypot(bl.x - tl.x, bl.y - bl.y);
  const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);

  // Must have minimum width and height (at least 25% of frame)
  if (topW < width * 0.25 || botW < width * 0.25 || leftH < height * 0.25 || rightH < height * 0.25) {
    return false;
  }

  // Must obey topological order: tl left of tr, bl left of br, tl above bl, tr above br
  if (tl.x >= tr.x || bl.x >= br.x || tl.y >= bl.y || tr.y >= br.y) {
    return false;
  }

  // Sheet aspect ratio H/W should be roughly portrait (supports A4 ~1.414 & Letter ~1.294 with perspective)
  const avgW = (topW + botW) / 2;
  const avgH = (leftH + rightH) / 2;
  const aspect = avgH / (avgW || 1);

  if (aspect < 0.85 || aspect > 2.20) {
    return false;
  }

  return true;
}

/**
 * Searches the 4 outer corner quadrants of the video frame or photo for the solid black square fiducials.
 * Uses OpenCV.js when available, with resilient local quadrant-adaptive thresholding as native engine.
 */
export function findRegistrationCorners(
  ctx: CanvasRenderingContext2D, 
  width: number, 
  height: number
): SheetCornerMarkers | null {
  // 1. If OpenCV is ready and canvas is accessible, try OpenCV contour detection first
  if (ctx.canvas && isOpenCvReady()) {
    const cvCorners = findCornersOpenCv(ctx.canvas);
    if (cvCorners) return cvCorners;
  }

  // 2. Native quadrant-adaptive thresholding engine
  return findRegistrationCornersNative(ctx, width, height);
}

/**
 * Native pure TypeScript corner fiducial detector with local quadrant adaptive thresholding.
 */
export function findRegistrationCornersNative(
  ctx: CanvasRenderingContext2D, 
  width: number, 
  height: number
): SheetCornerMarkers | null {
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  // Expected marker size range in current frame
  // Markers are 35px in 1000px canonical width (~3.5% of width)
  const expectedSize = Math.max(12, Math.round(width * 0.035));
  const minSize = Math.max(8, Math.round(expectedSize * 0.45));
  const maxSize = Math.round(expectedSize * 2.5);

  // Quadrant boundaries: outer 36% of frame gives ample margin for rotation and perspective tilt
  const qW = Math.floor(width * 0.36);
  const qH = Math.floor(height * 0.36);

  // Helper to scan a specific corner quadrant and find the best matching solid square marker
  function findBestMarkerInROI(
    minX: number, maxX: number, 
    minY: number, maxY: number, 
    cornerType: 'tl' | 'tr' | 'br' | 'bl'
  ): Point | null {
    // 1. Compute local quadrant average luminance for adaptive threshold
    let quadLumSum = 0;
    let quadCount = 0;
    const lumStep = 6;
    for (let sy = minY; sy < maxY; sy += lumStep) {
      for (let sx = minX; sx < maxX; sx += lumStep) {
        const i = (sy * width + sx) * 4;
        quadLumSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        quadCount++;
      }
    }
    const quadAvgLum = quadLumSum / (quadCount || 1);
    const localDarkThresh = Math.max(30, Math.min(115, quadAvgLum * 0.58));

    const candidates: MarkerCandidate[] = [];
    const step = 3;

    // Scan for dark seed pixels
    for (let y = minY; y < maxY - minSize; y += step * 2) {
      for (let x = minX; x < maxX - minSize; x += step * 2) {
        const i = (y * width + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

        if (lum < localDarkThresh) {
          // Measure horizontal extent of dark blob
          let rW = 0;
          while (x + rW < maxX && rW < maxSize) {
            const idx = (y * width + (x + rW)) * 4;
            const l = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
            if (l >= localDarkThresh + 25) break;
            rW += step;
          }

          // Measure vertical extent of dark blob
          let rH = 0;
          while (y + rH < maxY && rH < maxSize) {
            const idx = ((y + rH) * width + x) * 4;
            const l = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
            if (l >= localDarkThresh + 25) break;
            rH += step;
          }

          if (rW >= minSize && rW <= maxSize && rH >= minSize && rH <= maxSize) {
            const aspect = rW / (rH || 1);
            if (aspect >= 0.65 && aspect <= 1.55) {
              // Sample solid fill density inside the candidate bounding box
              let darkPixels = 0;
              let totalPixels = 0;
              const subStep = 2;
              let cXSum = 0;
              let cYSum = 0;

              for (let sy = y; sy < y + rH; sy += subStep) {
                for (let sx = x; sx < x + rW; sx += subStep) {
                  const sIdx = (sy * width + sx) * 4;
                  const sl = 0.299 * data[sIdx] + 0.587 * data[sIdx + 1] + 0.114 * data[sIdx + 2];
                  if (sl < localDarkThresh + 20) {
                    darkPixels++;
                    cXSum += sx;
                    cYSum += sy;
                  }
                  totalPixels++;
                }
              }

              const fillDensity = darkPixels / (totalPixels || 1);
              // Fiducial markers are solid black (> 55% dark density)
              if (fillDensity > 0.55 && darkPixels > 12) {
                const cx = cXSum / darkPixels;
                const cy = cYSum / darkPixels;

                // Cornerness score: distance to the actual outer corner of the frame
                let distToCorner = 0;
                if (cornerType === 'tl') distToCorner = Math.hypot(cx - 0, cy - 0);
                else if (cornerType === 'tr') distToCorner = Math.hypot(cx - width, cy - 0);
                else if (cornerType === 'br') distToCorner = Math.hypot(cx - width, cy - height);
                else if (cornerType === 'bl') distToCorner = Math.hypot(cx - 0, cy - height);

                // Higher score for closer to corner and high solid fill density
                const score = (1000 / (distToCorner + 40)) * fillDensity;
                candidates.push({ x: cx, y: cy, size: (rW + rH) / 2, score });
              }
            }
          }
        }
      }
    }

    if (candidates.length === 0) return null;
    // Return candidate with highest score
    candidates.sort((a, b) => b.score - a.score);
    return { x: candidates[0].x, y: candidates[0].y };
  }

  // Detect 4 corner centroids in their respective quadrants
  const tl = findBestMarkerInROI(10, qW, 10, qH, 'tl');
  const tr = findBestMarkerInROI(width - qW, width - 10, 10, qH, 'tr');
  const br = findBestMarkerInROI(width - qW, width - 10, height - qH, height - 10, 'br');
  const bl = findBestMarkerInROI(10, qW, height - qH, height - 10, 'bl');

  if (!tl || !tr || !br || !bl) {
    return null;
  }

  const corners: SheetCornerMarkers = {
    topLeft: tl,
    topRight: tr,
    bottomRight: br,
    bottomLeft: bl,
  };

  return validateCornersGeometry(corners, width, height) ? corners : null;
}

// -----------------------------------------------------------------------------
// PURE TYPESCRIPT 3x3 PROJECTIVE HOMOGRAPHY RECTIFICATION (WARP)
// -----------------------------------------------------------------------------

/**
 * Solves an 8x8 linear system using Gaussian elimination with partial pivoting.
 */
function solve8x8(A: number[][], b: number[]): number[] | null {
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

/**
 * Computes the 3x3 homography matrix coefficients [h0..h7] mapping destination canonical coordinates (u, v)
 * backward to source image coordinates (x, y) with sub-pixel precision.
 */
export function computeHomographyCoefficients(
  dstPts: { u: number; v: number }[],
  srcPts: { x: number; y: number }[]
): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const u = dstPts[i].u;
    const v = dstPts[i].v;
    const x = srcPts[i].x;
    const y = srcPts[i].y;

    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);

    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }

  return solve8x8(A, b);
}

/**
 * Pure TypeScript projective homography warp with bilinear subpixel interpolation.
 * Rectifies rotated, skewed, or perspective-distorted answer sheets into the standard 1000x1414 canonical canvas.
 * Zero external dependencies — runs on any browser, mobile WebView, or desktop offline.
 */
export function pureHomographyWarp(
  sourceCanvas: HTMLCanvasElement, 
  corners: SheetCornerMarkers, 
  destCanvas: HTMLCanvasElement
): void {
  destCanvas.width = CANONICAL_WIDTH;
  destCanvas.height = CANONICAL_HEIGHT;
  const destCtx = destCanvas.getContext('2d');
  const srcCtx = sourceCanvas.getContext('2d');
  if (!destCtx || !srcCtx) return;

  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

  const dstImgData = destCtx.createImageData(CANONICAL_WIDTH, CANONICAL_HEIGHT);
  const dstData = dstImgData.data;

  const canonicalCentroids = getCornerMarkerCentroids();
  const dstCorners = [
    { u: canonicalCentroids.topLeft.x, v: canonicalCentroids.topLeft.y },
    { u: canonicalCentroids.topRight.x, v: canonicalCentroids.topRight.y },
    { u: canonicalCentroids.bottomRight.x, v: canonicalCentroids.bottomRight.y },
    { u: canonicalCentroids.bottomLeft.x, v: canonicalCentroids.bottomLeft.y },
  ];

  const srcCorners = [
    corners.topLeft,
    corners.topRight,
    corners.bottomRight,
    corners.bottomLeft,
  ];

  const h = computeHomographyCoefficients(dstCorners, srcCorners);
  if (!h) {
    destCtx.drawImage(sourceCanvas, 0, 0, CANONICAL_WIDTH, CANONICAL_HEIGHT);
    return;
  }

  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;

  for (let v = 0; v < CANONICAL_HEIGHT; v++) {
    let w = h6 * 0 + h7 * v + 1;
    let xw = h0 * 0 + h1 * v + h2;
    let yw = h3 * 0 + h4 * v + h5;
    const rowOffset = v * CANONICAL_WIDTH;

    for (let u = 0; u < CANONICAL_WIDTH; u++) {
      const invW = 1 / w;
      const sx = xw * invW;
      const sy = yw * invW;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const dstIdx = (rowOffset + u) * 4;

      if (x0 >= 0 && x0 < srcW - 1 && y0 >= 0 && y0 < srcH - 1) {
        const fx = sx - x0;
        const fy = sy - y0;
        const fx1 = 1 - fx;
        const fy1 = 1 - fy;

        const idx00 = (y0 * srcW + x0) * 4;
        const idx10 = idx00 + 4;
        const idx01 = idx00 + srcW * 4;
        const idx11 = idx01 + 4;

        dstData[dstIdx] = Math.round(fy1 * (fx1 * srcData[idx00] + fx * srcData[idx10]) + fy * (fx1 * srcData[idx01] + fx * srcData[idx11]));
        dstData[dstIdx + 1] = Math.round(fy1 * (fx1 * srcData[idx00 + 1] + fx * srcData[idx10 + 1]) + fy * (fx1 * srcData[idx01 + 1] + fx * srcData[idx11 + 1]));
        dstData[dstIdx + 2] = Math.round(fy1 * (fx1 * srcData[idx00 + 2] + fx * srcData[idx10 + 2]) + fy * (fx1 * srcData[idx01 + 2] + fx * srcData[idx11 + 2]));
        dstData[dstIdx + 3] = 255;
      } else {
        dstData[dstIdx] = 255;
        dstData[dstIdx + 1] = 255;
        dstData[dstIdx + 2] = 255;
        dstData[dstIdx + 3] = 255;
      }

      w += h6;
      xw += h0;
      yw += h3;
    }
  }

  destCtx.putImageData(dstImgData, 0, 0);
}

/**
 * Warps the quadrilateral defined by the 4 corners into standard canonical dimensions.
 * Uses OpenCV.js warpPerspective when available, or our pure TypeScript projective homography engine.
 */
export function warpSheetToCanonical(
  sourceCanvas: HTMLCanvasElement, 
  corners: SheetCornerMarkers, 
  destCanvas: HTMLCanvasElement
): void {
  destCanvas.width = CANONICAL_WIDTH;
  destCanvas.height = CANONICAL_HEIGHT;

  const canonicalCentroids = getCornerMarkerCentroids();

  // 1. Check if OpenCV is loaded and available
  if (window.cv && window.cv.matFromArray && window.cv.warpPerspective) {
    try {
      const cv = window.cv;
      const srcMat = cv.imread(sourceCanvas);
      const dstMat = new cv.Mat();
      const dsize = new cv.Size(CANONICAL_WIDTH, CANONICAL_HEIGHT);

      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        corners.topLeft.x, corners.topLeft.y,
        corners.topRight.x, corners.topRight.y,
        corners.bottomRight.x, corners.bottomRight.y,
        corners.bottomLeft.x, corners.bottomLeft.y,
      ]);

      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        canonicalCentroids.topLeft.x, canonicalCentroids.topLeft.y,
        canonicalCentroids.topRight.x, canonicalCentroids.topRight.y,
        canonicalCentroids.bottomRight.x, canonicalCentroids.bottomRight.y,
        canonicalCentroids.bottomLeft.x, canonicalCentroids.bottomLeft.y,
      ]);

      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      cv.warpPerspective(srcMat, dstMat, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
      cv.imshow(destCanvas, dstMat);

      srcMat.delete();
      dstMat.delete();
      srcTri.delete();
      dstTri.delete();
      M.delete();
      return;
    } catch (e) {
      console.warn('OpenCV warpPerspective fallback to pure TypeScript homography:', e);
    }
  }

  // 2. Pure TypeScript Homography Warp with Bilinear Subpixel Sampling
  pureHomographyWarp(sourceCanvas, corners, destCanvas);
}

// -----------------------------------------------------------------------------
// BUBBLE FILL SAMPLING & OMR RECOGNITION
// -----------------------------------------------------------------------------

/**
 * Samples the darkness ratio inside a circular bubble on the rectified canvas.
 * Compares inner bubble against surrounding paper baseline to normalize against shadows and uneven lighting.
 */
export function sampleBubbleFill(
  ctx: CanvasRenderingContext2D, 
  centerX: number, 
  centerY: number, 
  radius: number
): { fillRatio: number; contrast: number; rawMeanLum: number; basePaperLum: number } {
  const r = Math.round(radius);
  const cx = Math.round(centerX);
  const cy = Math.round(centerY);

  // Sample bounding box of the bubble plus outer baseline paper ring
  const sampleR = r + 4;
  const side = sampleR * 2;
  const imgData = ctx.getImageData(cx - sampleR, cy - sampleR, side, side);
  const data = imgData.data;

  let innerLumSum = 0;
  let innerTotalPixels = 0;
  let outerLuminanceSum = 0;
  let outerCount = 0;

  // First pass: measure inner luminance and outer local paper baseline
  for (let dy = -sampleR; dy < sampleR; dy++) {
    for (let dx = -sampleR; dx < sampleR; dx++) {
      const distSq = dx * dx + dy * dy;
      const idx = ((dy + sampleR) * side + (dx + sampleR)) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];

      // Inner bubble region (inside 70% of radius to avoid the printed circle outline)
      if (distSq <= (r * 0.70) * (r * 0.70)) {
        innerLumSum += lum;
        innerTotalPixels++;
      }
      // Outer surrounding baseline paper ring
      else if (distSq >= (r + 1.5) * (r + 1.5) && distSq <= sampleR * sampleR) {
        outerLuminanceSum += lum;
        outerCount++;
      }
    }
  }

  const basePaperLum = outerCount > 0 ? outerLuminanceSum / outerCount : 220;
  const meanInnerLum = innerTotalPixels > 0 ? innerLumSum / innerTotalPixels : basePaperLum;

  // Second pass: count dark pixels relative to the local baseline paper luminance
  // Shaded pencil or pen marks are significantly darker than surrounding paper
  const localDarkDelta = Math.max(22, basePaperLum * 0.18);
  const markThresh = Math.max(30, basePaperLum - localDarkDelta);

  let innerDarkPixels = 0;
  for (let dy = -sampleR; dy < sampleR; dy++) {
    for (let dx = -sampleR; dx < sampleR; dx++) {
      const distSq = dx * dx + dy * dy;
      if (distSq <= (r * 0.70) * (r * 0.70)) {
        const idx = ((dy + sampleR) * side + (dx + sampleR)) * 4;
        const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        if (lum < markThresh) {
          innerDarkPixels++;
        }
      }
    }
  }

  const darkRatio = innerTotalPixels > 0 ? innerDarkPixels / innerTotalPixels : 0;
  const darknessDelta = Math.max(0, (basePaperLum - meanInnerLum) / Math.max(1, basePaperLum));

  // Combined fill ratio: accounts for dark pixel proportion and overall darkness drop
  // Blank bubbles with light letter glyphs produce < 0.12 fillRatio
  // Shaded bubbles with pencil or ink produce > 0.35 fillRatio
  const fillRatio = Math.min(1.0, darkRatio * 0.65 + darknessDelta * 0.35 * 1.5);
  const contrast = Math.max(0, (basePaperLum - 100) / 140);

  return { fillRatio, contrast, rawMeanLum: meanInnerLum, basePaperLum };
}

/**
 * Scans all student ID / LRN bubbles and extracts the identification number.
 * Automatically detects whether the sheet uses a 12-digit DepEd LRN or standard 5-digit Student ID.
 * Preserves all digits without truncation.
 */
export function extractStudentNumber(
  ctx: CanvasRenderingContext2D,
  preferredMode?: IdentifierMode
): { identifier: string; mode: IdentifierMode; lrn?: string; isComplete: boolean; markedCount: number } {
  // 1. Evaluate 12-digit LRN layout
  const lrnCoords = getStudentIdBubbleCoordinates('lrn_12');
  const lrnDigits: string[] = [];
  let lrnMarkedCount = 0;

  for (let col = 0; col < 12; col++) {
    const colBubbles = lrnCoords.filter(b => b.digitColumn === col);
    let maxFill = -1;
    let selectedDigit = -1;

    for (const b of colBubbles) {
      const x = b.normX * CANONICAL_WIDTH;
      const y = b.normY * CANONICAL_HEIGHT;
      const r = b.normRadius * CANONICAL_WIDTH;
      const { fillRatio } = sampleBubbleFill(ctx, x, y, r);

      if (fillRatio > maxFill) {
        maxFill = fillRatio;
        selectedDigit = b.digitValue;
      }
    }

    if (maxFill > 0.20 && selectedDigit >= 0) {
      lrnDigits.push(selectedDigit.toString());
      lrnMarkedCount++;
    } else {
      lrnDigits.push('0');
    }
  }

  // 2. Evaluate 5-digit Student ID layout
  const idCoords = getStudentIdBubbleCoordinates('student_id_5');
  const idDigits: string[] = [];
  let idMarkedCount = 0;

  for (let col = 0; col < 5; col++) {
    const colBubbles = idCoords.filter(b => b.digitColumn === col);
    let maxFill = -1;
    let selectedDigit = -1;

    for (const b of colBubbles) {
      const x = b.normX * CANONICAL_WIDTH;
      const y = b.normY * CANONICAL_HEIGHT;
      const r = b.normRadius * CANONICAL_WIDTH;
      const { fillRatio } = sampleBubbleFill(ctx, x, y, r);

      if (fillRatio > maxFill) {
        maxFill = fillRatio;
        selectedDigit = b.digitValue;
      }
    }

    if (maxFill > 0.20 && selectedDigit >= 0) {
      idDigits.push(selectedDigit.toString());
      idMarkedCount++;
    } else {
      idDigits.push('0');
    }
  }

  // Decide mode: if explicitly requested or if 12-digit LRN has >= 5 filled digits
  if (preferredMode === 'lrn_12' || (preferredMode !== 'student_id_5' && lrnMarkedCount >= 5)) {
    const lrnStr = lrnDigits.join('');
    return { 
      identifier: lrnStr, 
      mode: 'lrn_12', 
      lrn: lrnStr,
      isComplete: lrnMarkedCount === 12,
      markedCount: lrnMarkedCount
    };
  }

  const idStr = idDigits.join('');
  return { 
    identifier: idStr, 
    mode: 'student_id_5',
    isComplete: idMarkedCount === 5,
    markedCount: idMarkedCount
  };
}

/**
 * Scans all question bubbles, determines marked answers, identifies blank or multiple marks,
 * and calculates individual confidence ratings.
 */
export function scanQuestionBubbles(
  ctx: CanvasRenderingContext2D, 
  totalQuestions: number, 
  optionsCount: number = 4
): QuestionScanResult[] {
  const coords = getQuestionBubbleCoordinates(totalQuestions, optionsCount);
  const results: QuestionScanResult[] = [];

  for (let q = 1; q <= totalQuestions; q++) {
    const qCoords = coords.filter(c => c.questionNumber === q);
    const bubbleDetails: BubbleDetectionResult[] = [];

    let highestFill = -1;
    let secondHighestFill = -1;
    let highestOpt = '';

    for (const c of qCoords) {
      const x = c.normX * CANONICAL_WIDTH;
      const y = c.normY * CANONICAL_HEIGHT;
      const r = c.normRadius * CANONICAL_WIDTH;
      const { fillRatio } = sampleBubbleFill(ctx, x, y, r);

      bubbleDetails.push({
        questionNumber: q,
        optionLabel: c.optionLabel,
        fillRatio,
        isMarked: false,
        confidence: 0,
      });

      if (fillRatio > highestFill) {
        secondHighestFill = highestFill;
        highestFill = fillRatio;
        highestOpt = c.optionLabel;
      } else if (fillRatio > secondHighestFill) {
        secondHighestFill = fillRatio;
      }
    }

    // Decision Logic:
    // Configurable calibrated thresholds
    const BLANK_THRESH = 0.18;
    const LIGHT_PENCIL_THRESH = 0.22;
    const SHADED_THRESH = 0.28;

    // 1. Is Blank?
    const isBlank = highestFill < BLANK_THRESH;

    // 2. Is Multiple?
    // Detects when student shaded 2 or more options.
    // If student cleanly erased an answer, the erased mark has residual fill (~0.18-0.23)
    // while the intended mark has >= 0.38, giving margin > 0.14.
    // If margin <= 0.12 and secondHighest >= 0.22, or both >= 0.28, it is a multi-mark!
    const margin = highestFill - secondHighestFill;
    const isMultiple = !isBlank && (
      (secondHighestFill >= LIGHT_PENCIL_THRESH && margin <= 0.12) ||
      (secondHighestFill >= SHADED_THRESH)
    );

    // 3. Ambiguous / Uncertain Mark?
    // Faint mark (0.18 - 0.25) or close competition between choices
    const isAmbiguous = !isBlank && !isMultiple && (
      (highestFill < LIGHT_PENCIL_THRESH + 0.03) ||
      (margin < 0.10 && highestFill < 0.35)
    );

    const needsReview = isMultiple || isAmbiguous;

    const markedOptions: string[] = [];
    if (!isBlank) {
      if (isMultiple) {
        bubbleDetails.forEach(b => {
          if (b.fillRatio >= LIGHT_PENCIL_THRESH) {
            b.isMarked = true;
            markedOptions.push(b.optionLabel);
          }
        });
      } else {
        const topBubble = bubbleDetails.find(b => b.optionLabel === highestOpt);
        if (topBubble) topBubble.isMarked = true;
        markedOptions.push(highestOpt);
      }
    }

    // Calibrated Confidence Calculation
    let confidence = 98;
    if (isMultiple) {
      confidence = 30;
    } else if (isAmbiguous) {
      confidence = Math.max(35, Math.min(58, Math.round(42 + margin * 100)));
    } else if (!isBlank) {
      confidence = Math.min(100, Math.round(75 + margin * 80));
    }

    results.push({
      questionNumber: q,
      markedOptions,
      isMultiple,
      isBlank,
      needsReview,
      confidence,
      bubbleDetails,
    });
  }

  return results;
}

/**
 * Detects whether the rectified sheet is inverted 180 degrees (upside down).
 * Compares content density of top header region (title, student ID box) vs bottom footer region.
 * Automatically rotates canonical canvas 180° if sheet is inverted.
 */
export function checkAndCorrectInvertedSheet(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const w = canvas.width;
  const h = canvas.height;

  // Top header area (y: 80 to 280) vs Bottom footer area (y: h - 280 to h - 80)
  const topImg = ctx.getImageData(100, 80, w - 200, 200).data;
  const botImg = ctx.getImageData(100, h - 280, w - 200, 200).data;

  let topDark = 0;
  let botDark = 0;
  for (let i = 0; i < topImg.length; i += 16) {
    const lum = 0.299 * topImg[i] + 0.587 * topImg[i + 1] + 0.114 * topImg[i + 2];
    if (lum < 160) topDark++;
  }
  for (let i = 0; i < botImg.length; i += 16) {
    const lum = 0.299 * botImg[i] + 0.587 * botImg[i + 1] + 0.114 * botImg[i + 2];
    if (lum < 160) botDark++;
  }

  // If bottom has much more dark content than top, the sheet was held upside down
  if (botDark > topDark * 1.8 && botDark > 500) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d')!;
    tempCtx.drawImage(canvas, 0, 0);

    ctx.save();
    ctx.translate(w, h);
    ctx.rotate(Math.PI);
    ctx.drawImage(tempCanvas, 0, 0);
    ctx.restore();
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// COMPLETE OMR RECOGNITION PIPELINE
// -----------------------------------------------------------------------------

/**
 * Main entry point: Processes a raw video frame or uploaded photo canvas.
 */
export async function processOMRCanvas(
  sourceCanvas: HTMLCanvasElement, 
  totalQuestions: number = 20, 
  optionsCount: number = 4
): Promise<ScannedSheetData> {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const srcCtx = sourceCanvas.getContext('2d');

  if (!srcCtx) throw new Error('Could not access canvas context');

  // 1. Measure blur
  const sharpness = measureSharpness(srcCtx, width, height);
  const isBlurry = sharpness < 45;

  // 2. Measure lighting quality
  const lighting = measureLightingQuality(srcCtx, width, height);

  // 3. Locate 4 corner fiducial markers
  const corners = findRegistrationCorners(srcCtx, width, height);

  // Create rectified canonical canvas
  const canonicalCanvas = document.createElement('canvas');
  canonicalCanvas.width = CANONICAL_WIDTH;
  canonicalCanvas.height = CANONICAL_HEIGHT;
  const canCtx = canonicalCanvas.getContext('2d')!;

  if (corners) {
    warpSheetToCanonical(sourceCanvas, corners, canonicalCanvas);
    checkAndCorrectInvertedSheet(canonicalCanvas);
  } else {
    // If corners not cleanly detected, scale image into canonical canvas for direct scanning
    canCtx.drawImage(sourceCanvas, 0, 0, CANONICAL_WIDTH, CANONICAL_HEIGHT);
  }

  // 4. Extract Student ID / LRN Number
  const { identifier: detectedStudentNumber, mode: detectedIdMode, lrn: detectedLrn } = extractStudentNumber(canCtx);

  // 5. Scan Question Bubbles
  const questions = scanQuestionBubbles(canCtx, totalQuestions, optionsCount);

  // 6. Calculate overall confidence score
  const avgConf = Math.round(
    questions.reduce((acc, q) => acc + q.confidence, 0) / (questions.length || 1)
  );

  return {
    detectedStudentNumber,
    detectedLrn,
    idMode: detectedIdMode,
    questions,
    overallConfidence: avgConf,
    isBlurry,
    blurScore: sharpness,
    isPoorlyLit: lighting.isPoorlyLit,
    isOverexposed: lighting.isOverexposed,
    lightingScore: lighting.avgLum,
    cornersDetected: Boolean(corners),
    corners: corners || undefined,
    warpedCanvas: canonicalCanvas,
    timestamp: Date.now(),
  };
}

// -----------------------------------------------------------------------------
// AUTOMATIC GRADING ENGINE
// -----------------------------------------------------------------------------

/**
 * Evaluates scanned questions against the official quiz answer key.
 * Implements weighted scoring, bonus points, excluded questions, and pass/fail determination.
 */
export function gradeScannedAnswers(
  scanResults: QuestionScanResult[], 
  quiz: Quiz, 
  answerKeys: AnswerKey[]
): GradingEvaluation {
  let totalScore = 0;
  let maxScore = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;

  const itemResults = scanResults.map(scan => {
    const key = answerKeys.find(k => k.question_number === scan.questionNumber);
    const correctOpts = key?.correct_options || ['A'];
    const points = key?.points ?? quiz.default_points_per_question;
    const isBonus = key?.is_bonus ?? false;
    const isExcluded = key?.is_excluded ?? false;

    if (!isExcluded) {
      if (!isBonus) {
        maxScore += points;
      }
    }

    if (scan.isBlank) {
      unansweredCount++;
      return {
        questionNumber: scan.questionNumber,
        marked: [],
        correct: correctOpts,
        isCorrect: false,
        pointsAwarded: 0,
        isBonus,
        isExcluded,
        confidence: scan.confidence,
        isMultiple: false,
        isBlank: true,
        needsReview: false,
      };
    }

    // Uncertain or multiple-mark answers are never counted as correct unless confirmed
    const isCorrect = !scan.isMultiple && !scan.needsReview && scan.markedOptions.some(opt => correctOpts.includes(opt));

    if (isExcluded) {
      return {
        questionNumber: scan.questionNumber,
        marked: scan.markedOptions,
        correct: correctOpts,
        isCorrect,
        pointsAwarded: 0,
        isBonus,
        isExcluded: true,
        confidence: scan.confidence,
        isMultiple: scan.isMultiple,
        isBlank: false,
        needsReview: scan.needsReview,
      };
    }

    let awarded = 0;
    if (isCorrect) {
      awarded = points;
      totalScore += points;
      correctCount++;
    } else {
      incorrectCount++;
    }

    return {
      questionNumber: scan.questionNumber,
      marked: scan.markedOptions,
      correct: correctOpts,
      isCorrect,
      pointsAwarded: awarded,
      isBonus,
      isExcluded: false,
      confidence: scan.confidence,
      isMultiple: scan.isMultiple,
      isBlank: false,
      needsReview: scan.needsReview,
    };
  });

  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : 0;
  const passed = percentage >= quiz.passing_percentage;

  return {
    totalScore: Math.round(totalScore * 10) / 10,
    maxScore: Math.round(maxScore * 10) / 10,
    percentage,
    correctCount,
    incorrectCount,
    unansweredCount,
    passed,
    itemResults,
  };
}
