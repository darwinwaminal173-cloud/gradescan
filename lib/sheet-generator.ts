// ==============================================================================
// GradeScan - High-Precision Vector & Canvas Printable PDF Answer Sheet Generator
// Multi-Device Resilient PDF Generation & 4-Corner Fiducial Layout
// ==============================================================================

import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { 
  CANONICAL_WIDTH, 
  CANONICAL_HEIGHT, 
  getCornerMarkerSpecs, 
  getStudentIdBubbleCoordinates, 
  getQuestionBubbleCoordinates 
} from '@/lib/omr-engine';

export interface AnswerSheetConfig {
  title: string;
  className?: string;
  examDate?: string;
  totalQuestions: number;
  optionsCount?: number; // Defaults to 4 (A, B, C, D)
  quizId?: string;
  customInstructions?: string;
  idMode?: 'student_id_5' | 'lrn_12';
  studentName?: string;
  studentId?: string;
  prefillBubbles?: boolean;
}

export interface PDFDownloadResult {
  success: boolean;
  filename: string;
  blobUrl: string;
  blob: Blob;
  shared: boolean;
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Draws the complete answer sheet directly onto an HTML5 2D Canvas.
 * This guarantees 100% reliable pixel-perfect rasterization without
 * relying on browser SVG-to-Image blob conversion that can fail on mobile WebKit/Safari.
 */
export async function renderAnswerSheetToCanvas(
  canvas: HTMLCanvasElement,
  config: AnswerSheetConfig
): Promise<void> {
  const {
    title,
    className = 'General Science',
    examDate = new Date().toISOString().split('T')[0],
    totalQuestions,
    optionsCount = 4,
    quizId = 'GRADESCAN-DEMO',
    idMode = 'student_id_5',
    studentName,
    studentId,
    prefillBubbles = false,
  } = config;

  // 2x supersampling for ultra-crisp print quality (2000 x 2828)
  const scale = 2;
  canvas.width = CANONICAL_WIDTH * scale;
  canvas.height = CANONICAL_HEIGHT * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D canvas context');

  // Enable high-quality smoothing
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 1. Crisp White Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.scale(scale, scale);

  // 2. Four Optical Corner Fiducial Markers (Solid Black Squares)
  const markers = getCornerMarkerSpecs();
  ctx.fillStyle = '#000000';
  ctx.fillRect(markers.topLeft.x, markers.topLeft.y, markers.topLeft.size, markers.topLeft.size);
  ctx.fillRect(markers.topRight.x, markers.topRight.y, markers.topRight.size, markers.topRight.size);
  ctx.fillRect(markers.bottomRight.x, markers.bottomRight.y, markers.bottomRight.size, markers.bottomRight.size);
  ctx.fillRect(markers.bottomLeft.x, markers.bottomLeft.y, markers.bottomLeft.size, markers.bottomLeft.size);

  // 3. Header & GradeScan Branding Section
  // Badge
  ctx.fillStyle = '#0f766e';
  roundRect(ctx, 100, 48, 96, 22, 4, true, false);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('GRADESCAN', 148, 59);

  // Title
  ctx.fillStyle = '#0f172a';
  ctx.font = '800 21px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, 208, 66);

  // Subtitle
  ctx.fillStyle = '#475569';
  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(`Class/Subject: ${className}   •   Exam Date: ${examDate}   •   Total Items: ${totalQuestions} Qs (A-D)`, 100, 92);

  // 4. Generate & Draw QR Code
  try {
    const qrDataUrl = await QRCode.toDataURL(JSON.stringify({ quizId, q: totalQuestions, opt: 4, mode: idMode }), {
      margin: 1,
      width: 170,
      color: { dark: '#000000', light: '#ffffff' }
    });
    const qrImg = new Image();
    await new Promise<void>((resolve) => {
      qrImg.onload = () => {
        ctx.drawImage(qrImg, 810, 40, 85, 85);
        resolve();
      };
      qrImg.onerror = () => resolve(); // Non-blocking fallback
      qrImg.src = qrDataUrl;
    });
  } catch (e) {
    console.warn('QR code generation note:', e);
  }

  // 5. Student Identification Fill-in Header (Left Column)
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1.2;

  // Student Full Name Box
  ctx.fillStyle = '#f8fafc';
  roundRect(ctx, 100, 115, idMode === 'lrn_12' ? 440 : 510, 38, 4, true, true);
  ctx.fillStyle = '#475569';
  ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('STUDENT FULL NAME (LAST, FIRST, M.I.):', 112, 120);
  if (studentName) {
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(studentName.toUpperCase(), 112, 134);
  }

  // Grade Level & Section Box
  ctx.fillStyle = '#f8fafc';
  roundRect(ctx, 100, 161, idMode === 'lrn_12' ? 215 : 250, 38, 4, true, true);
  ctx.fillStyle = '#475569';
  ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('GRADE LEVEL & SECTION:', 112, 166);
  if (className) {
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(className, 112, 180);
  }

  // Date & Subject Box
  const dateBoxX = idMode === 'lrn_12' ? 325 : 360;
  const dateBoxW = idMode === 'lrn_12' ? 215 : 250;
  ctx.fillStyle = '#f8fafc';
  roundRect(ctx, dateBoxX, 161, dateBoxW, 38, 4, true, true);
  ctx.fillStyle = '#475569';
  ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('DATE & SUBJECT:', dateBoxX + 12, 166);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(examDate, dateBoxX + 12, 180);

  // Instructions Box
  ctx.fillStyle = '#f8fafc';
  roundRect(ctx, 100, 207, idMode === 'lrn_12' ? 440 : 510, 78, 4, true, true);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('EXAMINATION MARKING INSTRUCTIONS:', 112, 215);

  ctx.fillStyle = '#475569';
  ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('• Use dark pencil (No. 2 / HB) or black ink pen. Fill bubble completely: [●] (Incorrect: [✔] [✖] [○])', 112, 233);
  if (idMode === 'lrn_12') {
    ctx.fillText('• Bubble your 12-digit DepEd LRN in the grid on the right.', 112, 250);
  } else {
    ctx.fillText('• Bubble your 5-digit Student ID / LRN in the grid on the right.', 112, 250);
  }
  ctx.fillText('• Keep this sheet flat without folds, tears, or stray marks for accurate computer grading.', 112, 267);

  // 6. Student ID / LRN Bubble Matrix
  const cleanId = (studentId || '').trim();
  const shouldPrefill = !!prefillBubbles && cleanId.length > 0;

  if (idMode === 'lrn_12') {
    // 12-column LRN matrix
    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = '#cbd5e1';
    roundRect(ctx, 555, 120, 360, 335, 6, true, true);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('LEARNER REFERENCE NUMBER (LRN)', 735, 127);

    // 12 digit boxes
    for (let col = 0; col < 12; col++) {
      const x = 576 + col * 28;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#94a3b8';
      roundRect(ctx, x - 11, 144, 22, 22, 3, true, true);

      if (cleanId[col] !== undefined) {
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cleanId[col], x, 155);
      }
    }

    // Draw LRN bubbles (0-9 for each of the 12 columns)
    const idBubbles = getStudentIdBubbleCoordinates('lrn_12');
    for (const b of idBubbles) {
      const x = b.normX * CANONICAL_WIDTH;
      const y = b.normY * CANONICAL_HEIGHT;
      const r = b.normRadius * CANONICAL_WIDTH;
      const isFilled = shouldPrefill && cleanId[b.digitColumn] === String(b.digitValue);

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isFilled ? '#0f172a' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.3;
      ctx.stroke();

      ctx.fillStyle = isFilled ? '#ffffff' : '#0f172a';
      ctx.font = 'bold 9.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.digitValue.toString(), x, y);
    }
  } else {
    // 5-column Student ID matrix
    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = '#cbd5e1';
    roundRect(ctx, 635, 125, 210, 325, 6, true, true);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('STUDENT ID / LRN', 740, 137);

    const paddedId = cleanId ? cleanId.padStart(5, '0') : '';

    // Column header boxes for handwritten digits
    for (let col = 0; col < 5; col++) {
      const x = 650 + col * 36;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#94a3b8';
      roundRect(ctx, x - 13, 156, 26, 24, 3, true, true);

      if (paddedId && paddedId[col] !== undefined) {
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(paddedId[col], x, 168);
      }
    }

    // Draw Student ID bubbles (0-9 for each column)
    const idBubbles = getStudentIdBubbleCoordinates('student_id_5');
    for (const b of idBubbles) {
      const x = b.normX * CANONICAL_WIDTH;
      const y = b.normY * CANONICAL_HEIGHT;
      const r = b.normRadius * CANONICAL_WIDTH;
      const isFilled = shouldPrefill && paddedId[b.digitColumn] === String(b.digitValue);

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isFilled ? '#0f172a' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.fillStyle = isFilled ? '#ffffff' : '#0f172a';
      ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.digitValue.toString(), x, y);
    }
  }

  // 7. Divider Line before Questions
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(70, 465);
  ctx.lineTo(930, 465);
  ctx.strokeStyle = '#0f766e';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#0f766e';
  ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('ANSWER CHOICES (A, B, C, D)', 500, 460);

  // 8. Draw Question Rows & Bubbles (Choices A, B, C, D)
  const qBubbles = getQuestionBubbleCoordinates(totalQuestions, 4);

  for (let q = 1; q <= totalQuestions; q++) {
    const qCoords = qBubbles.filter(b => b.questionNumber === q);
    if (qCoords.length === 0) continue;

    const first = qCoords[0];
    const qX = first.normX * CANONICAL_WIDTH - 25;
    const qY = first.normY * CANONICAL_HEIGHT;

    // Question number
    ctx.fillStyle = '#0f766e';
    ctx.font = '800 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${q}.`, qX, qY);

    // Option bubbles
    for (const b of qCoords) {
      const bx = b.normX * CANONICAL_WIDTH;
      const by = b.normY * CANONICAL_HEIGHT;
      const br = b.normRadius * CANONICAL_WIDTH;

      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.fillStyle = '#0f172a';
      ctx.font = '800 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.optionLabel, bx, by);
    }
  }

  // 9. Footer
  ctx.fillStyle = '#64748b';
  ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('GradeScan Examination Platform  •  Align 4 corner black boxes within camera view to grade', 500, 1385);

  ctx.restore();
}

/**
 * Helper to draw rounded rectangle on 2D canvas context.
 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill = true,
  stroke = false
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

/**
 * Generates an SVG string representation of the OMR answer sheet.
 * Used for live on-screen previews and high-fidelity browser printing.
 */
export async function generateAnswerSheetSVG(config: AnswerSheetConfig): Promise<string> {
  const {
    title,
    className = 'General Science',
    examDate = new Date().toISOString().split('T')[0],
    totalQuestions,
    optionsCount = 4,
    quizId = 'GRADESCAN-DEMO',
    idMode = 'student_id_5',
    studentName,
    studentId,
    prefillBubbles = false,
  } = config;

  // Generate QR Code data URL
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(JSON.stringify({ quizId, q: totalQuestions, opt: 4, mode: idMode }), {
      margin: 1,
      width: 120,
    });
  } catch (e) {
    console.warn('QR code generation failed, using fallback', e);
  }

  const markers = getCornerMarkerSpecs();
  const idBubbles = getStudentIdBubbleCoordinates(idMode);
  const qBubbles = getQuestionBubbleCoordinates(totalQuestions, 4);

  const cleanId = (studentId || '').trim();
  const shouldPrefill = !!prefillBubbles && cleanId.length > 0;
  const paddedId = idMode === 'student_id_5' && cleanId ? cleanId.padStart(5, '0') : cleanId;

  const headerW = idMode === 'lrn_12' ? 440 : 510;
  const colW = idMode === 'lrn_12' ? 215 : 250;
  const col2X = idMode === 'lrn_12' ? 225 : 260;

  let svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANONICAL_WIDTH} ${CANONICAL_HEIGHT}" width="100%" height="100%" style="background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <style>
    .marker { fill: #000000; }
    .label { font-size: 13px; font-weight: 700; fill: #0f172a; }
    .muted { font-size: 10px; fill: #475569; font-weight: 500; }
    .title { font-size: 21px; font-weight: 800; fill: #0f172a; }
    .sub { font-size: 12px; fill: #475569; font-weight: 600; }
    .bubble-border { stroke: #0f172a; stroke-width: 1.4; fill: #ffffff; }
    .bubble-filled { stroke: #0f172a; stroke-width: 1.4; fill: #0f172a; }
    .bubble-text { font-size: 10px; font-weight: 800; fill: #0f172a; text-anchor: middle; dominant-baseline: central; }
    .bubble-text-inv { font-size: 10px; font-weight: 800; fill: #ffffff; text-anchor: middle; dominant-baseline: central; }
    .q-number { font-size: 12.5px; font-weight: 800; fill: #0f766e; text-anchor: end; dominant-baseline: central; }
    .header-box { stroke: #cbd5e1; stroke-width: 1.2; fill: #f8fafc; rx: 4; }
    .badge { fill: #0f766e; rx: 4; }
    .badge-text { font-size: 11px; font-weight: bold; fill: #ffffff; text-anchor: middle; dominant-baseline: central; }
  </style>

  <!-- 1. Four Optical Corner Fiducial Markers -->
  <rect class="marker" x="${markers.topLeft.x}" y="${markers.topLeft.y}" width="${markers.topLeft.size}" height="${markers.topLeft.size}" />
  <rect class="marker" x="${markers.topRight.x}" y="${markers.topRight.y}" width="${markers.topRight.size}" height="${markers.topRight.size}" />
  <rect class="marker" x="${markers.bottomRight.x}" y="${markers.bottomRight.y}" width="${markers.bottomRight.size}" height="${markers.bottomRight.size}" />
  <rect class="marker" x="${markers.bottomLeft.x}" y="${markers.bottomLeft.y}" width="${markers.bottomLeft.size}" height="${markers.bottomLeft.size}" />

  <!-- 2. Header & GradeScan Branding Section -->
  <g transform="translate(100, 48)">
    <rect class="badge" x="0" y="2" width="96" height="22" rx="4" />
    <text class="badge-text" x="48" y="14">GRADESCAN</text>
    <text class="title" x="108" y="20">${escapeXml(title)}</text>
    <text class="sub" x="0" y="44">Class/Subject: ${escapeXml(className)}   •   Exam Date: ${escapeXml(examDate)}   •   Total Items: ${totalQuestions} Qs (A-D)</text>
  </g>

  <!-- QR Code -->
  ${qrDataUrl ? `<image href="${qrDataUrl}" x="810" y="40" width="85" height="85" />` : ''}

  <!-- 3. Student Identification Fill-in Header -->
  <g transform="translate(100, 115)">
    <rect class="header-box" x="0" y="0" width="${headerW}" height="38" />
    <text class="muted" x="12" y="15">STUDENT FULL NAME (LAST, FIRST, M.I.):</text>
    ${studentName ? `<text x="12" y="30" font-size="12" font-weight="700" fill="#0f172a">${escapeXml(studentName.toUpperCase())}</text>` : ''}

    <rect class="header-box" x="0" y="46" width="${colW}" height="38" />
    <text class="muted" x="12" y="60">GRADE LEVEL &amp; SECTION:</text>
    ${className ? `<text x="12" y="75" font-size="11" font-weight="700" fill="#0f172a">${escapeXml(className)}</text>` : ''}

    <rect class="header-box" x="${col2X}" y="46" width="${colW}" height="38" />
    <text class="muted" x="${col2X + 12}" y="60">DATE &amp; SUBJECT:</text>
    <text x="${col2X + 12}" y="75" font-size="11" font-weight="700" fill="#0f172a">${escapeXml(examDate)}</text>

    <rect class="header-box" x="0" y="92" width="${headerW}" height="78" />
    <text class="label" x="12" y="112">EXAMINATION MARKING INSTRUCTIONS:</text>
    <text class="muted" x="12" y="130">• Use dark pencil (No. 2 / HB) or black ink pen. Fill bubble completely: [●] (Incorrect: [✔] [✖] [○])</text>
    <text class="muted" x="12" y="146">• Bubble your ${idMode === 'lrn_12' ? '12-digit DepEd LRN' : '5-digit Student ID / LRN'} in the grid on the right.</text>
    <text class="muted" x="12" y="162">• Keep this sheet flat without folds, tears, or stray marks for accurate computer grading.</text>
  </g>

  <!-- 4. Student ID / LRN Bubble Matrix -->
  <g id="student-id-matrix">
  `;

  if (idMode === 'lrn_12') {
    svg += `
    <rect x="555" y="120" width="360" height="335" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.2" rx="6" />
    <text class="label" x="735" y="137" text-anchor="middle" font-size="11">LEARNER REFERENCE NUMBER (LRN)</text>
    `;

    for (let col = 0; col < 12; col++) {
      const x = 576 + col * 28;
      const char = cleanId[col] || '';
      svg += `<rect x="${x - 11}" y="144" width="22" height="22" fill="#ffffff" stroke="#94a3b8" stroke-width="1.2" rx="3" />`;
      if (char) {
        svg += `<text x="${x}" y="157" font-size="12" font-weight="700" fill="#0f172a" text-anchor="middle" dominant-baseline="central">${char}</text>`;
      }
    }
  } else {
    svg += `
    <rect x="635" y="125" width="210" height="325" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.2" rx="6" />
    <text class="label" x="740" y="148" text-anchor="middle">STUDENT ID / LRN</text>
    `;

    for (let col = 0; col < 5; col++) {
      const x = 650 + col * 36;
      const char = paddedId[col] || '';
      svg += `<rect x="${x - 13}" y="156" width="26" height="24" fill="#ffffff" stroke="#94a3b8" stroke-width="1.2" rx="3" />`;
      if (char) {
        svg += `<text x="${x}" y="170" font-size="13" font-weight="700" fill="#0f172a" text-anchor="middle" dominant-baseline="central">${char}</text>`;
      }
    }
  }

  // Draw Student ID / LRN bubbles
  for (const b of idBubbles) {
    const x = b.normX * CANONICAL_WIDTH;
    const y = b.normY * CANONICAL_HEIGHT;
    const r = b.normRadius * CANONICAL_WIDTH;
    const isFilled = shouldPrefill && paddedId[b.digitColumn] === String(b.digitValue);

    svg += `
      <circle class="${isFilled ? 'bubble-filled' : 'bubble-border'}" cx="${x}" cy="${y}" r="${r}" />
      <text class="${isFilled ? 'bubble-text-inv' : 'bubble-text'}" x="${x}" y="${y}">${b.digitValue}</text>
    `;
  }

  svg += `</g>`;

  // Divider line before questions
  svg += `
    <line x1="70" y1="465" x2="930" y2="465" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="4 4" />
    <text class="muted" x="500" y="460" text-anchor="middle" font-size="11" font-weight="700" fill="#0f766e">ANSWER CHOICES (A, B, C, D)</text>
  `;

  // Draw Question Rows & Bubbles (Choices A, B, C, D)
  for (let q = 1; q <= totalQuestions; q++) {
    const qCoords = qBubbles.filter(b => b.questionNumber === q);
    if (qCoords.length === 0) continue;

    const first = qCoords[0];
    const qX = first.normX * CANONICAL_WIDTH - 25;
    const qY = first.normY * CANONICAL_HEIGHT;

    svg += `<text class="q-number" x="${qX}" y="${qY}">${q}.</text>`;

    for (const b of qCoords) {
      const bx = b.normX * CANONICAL_WIDTH;
      const by = b.normY * CANONICAL_HEIGHT;
      const br = b.normRadius * CANONICAL_WIDTH;

      svg += `
        <circle class="bubble-border" cx="${bx}" cy="${by}" r="${br}" />
        <text class="bubble-text" x="${bx}" y="${by}">${b.optionLabel}</text>
      `;
    }
  }

  // Footer
  svg += `
    <text class="muted" x="500" y="1385" text-anchor="middle">GradeScan Examination Platform  •  Align 4 corner black boxes within camera view to grade</text>
  </svg>
  `;

  return svg;
}

/**
 * Generates an in-memory PDF Blob with strictly 1 single page.
 * Uses high-resolution direct Canvas rasterization to eliminate SVG blob failures on mobile browsers.
 */
export async function generateAnswerSheetPDFBlob(config: AnswerSheetConfig): Promise<{ blob: Blob; filename: string }> {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  const canvas = document.createElement('canvas');
  await renderAnswerSheetToCanvas(canvas, config);

  const imgData = canvas.toDataURL('image/jpeg', 0.96);
  // Render exactly on standard 210 x 297mm A4 portrait page
  doc.addImage(imgData, 'JPEG', 0, 0, 210, 297, undefined, 'FAST');

  // Strict single-page guarantee: purge any accidental extra pages
  while (doc.getNumberOfPages() > 1) {
    doc.deletePage(2);
  }

  const idTag = config.idMode === 'lrn_12' ? 'lrn12' : 'id5';
  const studentTag = config.studentId ? `_${config.studentId}` : '';
  const safeFilename = `${config.title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${idTag}${studentTag}_${config.totalQuestions}q.pdf`;
  const pdfBlob = doc.output('blob');
  const typedBlob = new Blob([pdfBlob], { type: 'application/pdf' });

  return { blob: typedBlob, filename: safeFilename };
}

/**
 * Downloads a high-resolution, vector-accurate printable PDF document.
 * Includes mobile Web Share API integration, anchor download, and direct tab opening fallback.
 */
export async function downloadAnswerSheetPDF(config: AnswerSheetConfig): Promise<PDFDownloadResult> {
  const { blob, filename } = await generateAnswerSheetPDFBlob(config);
  const blobUrl = URL.createObjectURL(blob);

  let shared = false;
  const isMobile = typeof navigator !== 'undefined' && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  // If on mobile and Web Share API is available, share the actual PDF file directly
  if (isMobile && typeof navigator !== 'undefined' && 'canShare' in navigator) {
    try {
      const pdfFile = new File([blob], filename, { type: 'application/pdf' });
      if (navigator.canShare({ files: [pdfFile] })) {
        await navigator.share({
          files: [pdfFile],
          title: `${config.title} Answer Sheet`,
          text: `GradeScan Printable Answer Sheet (${config.totalQuestions} Questions)`,
        });
        shared = true;
      }
    } catch (shareErr: any) {
      if (shareErr.name === 'AbortError') {
        return { success: true, filename, blobUrl, blob, shared: false };
      }
      console.warn('Web Share failed, proceeding with direct download:', shareErr);
    }
  }

  // Fallback: cross-browser anchor download
  if (!shared) {
    try {
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (downloadErr) {
      console.warn('Anchor download fallback: opening in new tab', downloadErr);
      window.open(blobUrl, '_blank');
    }

    // Keep blob URL active for 60 seconds to ensure download managers finish
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 60000);
  }

  return {
    success: true,
    filename,
    blobUrl,
    blob,
    shared,
  };
}
