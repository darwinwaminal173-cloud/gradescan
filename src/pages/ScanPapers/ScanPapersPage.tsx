// ==============================================================================
// GradeScan - Real-Time Full-Screen Portrait Camera OMR Scanner
// High-Precision Automatic Capture, Auto-Save & Color-Coded Answer Checking
// ==============================================================================

import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { 
  Camera, 
  Upload, 
  RotateCw, 
  CheckCircle2, 
  AlertCircle, 
  AlertTriangle, 
  Sparkles, 
  UserCheck, 
  FileText, 
  ScanLine, 
  Save, 
  RefreshCw, 
  Sliders, 
  Check, 
  X, 
  Volume2, 
  VolumeX, 
  SwitchCamera,
  ShieldCheck,
  Zap,
  Layers,
  ArrowRight,
  Maximize2,
  Minimize2,
  Info,
  Activity
} from 'lucide-react';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import confetti from 'canvas-confetti';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { db } from '@/services/db';
import { cameraService, CameraDeviceInfo } from '@/services/camera';
import { Quiz, AnswerKey, Student, ExamResult } from '@/types/database';
import { 
  processOMRCanvas, 
  gradeScannedAnswers, 
  CANONICAL_WIDTH, 
  CANONICAL_HEIGHT,
  findRegistrationCorners,
  measureSharpness,
  getStudentIdBubbleCoordinates,
  getQuestionBubbleCoordinates
} from '@/lib/omr-engine';
import { renderAnswerSheetToCanvas } from '@/lib/sheet-generator';
import { runCalibrationBenchmark, CalibrationResultMetrics } from '@/lib/omr-calibration';
import { ScannedSheetData, GradingEvaluation, QuestionScanResult, Point } from '@/types/omr';

interface SessionScannedRecord {
  id: string;
  studentName: string;
  studentNumber: string;
  totalScore: number;
  maxScore: number;
  percentage: number;
  passed: boolean;
  timestamp: string;
}

export const ScanPapersPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const quizIdParam = searchParams.get('quizId');

  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedQuiz, setSelectedQuiz] = useState<Quiz | null>(null);
  const [answerKeys, setAnswerKeys] = useState<AnswerKey[]>([]);

  // Camera & Stream states
  const [cameraActive, setCameraActive] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [devices, setDevices] = useState<CameraDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [activeDeviceLabel, setActiveDeviceLabel] = useState<string>('');
  const [activeFacingMode, setActiveFacingMode] = useState<'environment' | 'user'>('environment');
  const [activePermission, setActivePermission] = useState<string>('prompt');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [autoCaptureEnabled, setAutoCaptureEnabled] = useState(true);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);

  // Diagnostics & Calibration modals
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false);
  const [showCalibrationModal, setShowCalibrationModal] = useState(false);
  const [calibrationMetrics, setCalibrationMetrics] = useState<CalibrationResultMetrics | null>(null);
  const [isCalibrating, setIsCalibrating] = useState(false);

  // Optical alignment & status states
  const [alignmentState, setAlignmentState] = useState<'searching' | 'detected' | 'stable' | 'capturing'>('searching');
  const [scanStatusMessage, setScanStatusMessage] = useState<string>('Align answer sheet with the 4 corner targets');
  const [autoSaveToast, setAutoSaveToast] = useState<{
    studentName: string;
    studentNumber: string;
    score: number;
    maxScore: number;
    percentage: number;
    passed: boolean;
  } | null>(null);

  // Scan Results & Review State
  const [scanResult, setScanResult] = useState<ScannedSheetData | null>(null);
  const [evaluation, setEvaluation] = useState<GradingEvaluation | null>(null);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [matchedStudent, setMatchedStudent] = useState<Student | null>(null);
  const [manualStudentId, setManualStudentId] = useState<string>('');
  const [reviewQuestions, setReviewQuestions] = useState<QuestionScanResult[]>([]);
  const [scannedImageUrl, setScannedImageUrl] = useState<string | null>(null);
  const [savingResult, setSavingResult] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [sessionRecords, setSessionRecords] = useState<SessionScannedRecord[]>([]);

  // References
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastCornersRef = useRef<{ tl: Point; tr: Point; br: Point; bl: Point } | null>(null);
  const stableCountRef = useRef<number>(0);
  const lastCaptureTimeRef = useRef<number>(0);
  const isStartingRef = useRef<boolean>(false);
  const isSavingRef = useRef<boolean>(false);

  // Stream dimensions, container sizing & hardware rotation states
  const [streamDimensions, setStreamDimensions] = useState<{ width: number; height: number; isPortrait: boolean }>({
    width: 0,
    height: 0,
    isPortrait: true,
  });
  const [feedRotation, setFeedRotation] = useState<0 | 90 | 180 | 270>(0);
  const [manualRotationSet, setManualRotationSet] = useState<boolean>(false);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    loadInitialData();
    enumerateCameras();

    // Automatically initialize and launch portrait camera on mount
    const autoStartTimer = setTimeout(() => {
      startCamera();
    }, 350);

    return () => {
      clearTimeout(autoStartTimer);
      stopCamera();
    };
  }, []);

  // Responsive container observer for pixel-perfect rotation and containment
  useEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      if (containerRef.current) {
        setContainerSize({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    updateSize();
    const obs = new ResizeObserver(updateSize);
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [cameraActive]);

  useEffect(() => {
    if (selectedQuiz) {
      loadQuizDetails(selectedQuiz.id);
    }
  }, [selectedQuiz]);

  const loadInitialData = async () => {
    try {
      const [qList, sList] = await Promise.all([
        db.getQuizzes(),
        db.getStudents(),
      ]);
      setQuizzes(qList);
      setStudents(sList);

      if (quizIdParam) {
        const found = qList.find(q => q.id === quizIdParam);
        if (found) setSelectedQuiz(found);
      } else if (qList.length > 0) {
        setSelectedQuiz(qList[0]);
      }
    } catch (e) {
      console.error('Error loading initial quiz data:', e);
    }
  };

  const loadQuizDetails = async (quizId: string) => {
    try {
      const keys = await db.getAnswerKeys(quizId);
      setAnswerKeys(keys);
    } catch (e) {
      console.error('Error loading answer keys:', e);
    }
  };

  const enumerateCameras = async () => {
    try {
      const perm = await cameraService.checkPermission();
      setActivePermission(perm);
      const cams = await cameraService.getAvailableCameras();
      setDevices(cams);
      if (cams.length > 0 && !selectedDeviceId) {
        const def = cameraService.selectDefaultCamera(cams);
        setSelectedDeviceId(def);
        const match = cams.find(c => c.deviceId === def);
        if (match) setActiveDeviceLabel(match.label);
      }
    } catch (e) {
      console.warn('Camera enumeration note:', e);
    }
  };

  const startCamera = async (targetDeviceId?: string) => {
    if (isStartingRef.current) return;
    isStartingRef.current = true;
    try {
      setCameraError(null);
      stopCamera();

      // 1. Force screen orientation to portrait on mobile/Android devices
      try {
        await ScreenOrientation.lock({ orientation: 'portrait' });
      } catch (e) {
        try {
          if (screen.orientation && 'lock' in screen.orientation) {
            await (screen.orientation as any).lock('portrait');
          }
        } catch (err) {
          // Screen orientation locking not supported or blocked by browser user gesture policy
        }
      }

      if (!videoRef.current) {
        console.warn('[ScanPapersPage] videoRef.current is null on startCamera');
        return;
      }

      const devId = targetDeviceId || selectedDeviceId || undefined;
      const streamInfo = await cameraService.startCamera(videoRef.current, {
        deviceId: devId,
        preferFacingMode: activeFacingMode,
      });

      setCameraActive(true);
      setSelectedDeviceId(streamInfo.deviceId);
      setActiveDeviceLabel(streamInfo.deviceLabel);
      setHasTorch(streamInfo.hasTorch);
      setActivePermission('granted');

      setStreamDimensions({
        width: streamInfo.videoWidth,
        height: streamInfo.videoHeight,
        isPortrait: streamInfo.isPortrait,
      });

      inspectAndConfigureStreamOrientation();
      setAlignmentState('searching');
      setScanStatusMessage('Position all 4 corner black boxes within view');

      // Refresh camera device list now that user granted permission (populates labels)
      enumerateCameras();

      startLiveScanningLoop();
    } catch (err: any) {
      console.error('Camera access error:', err);
      const friendlyMsg = cameraService.formatErrorMessage(err);
      setCameraError(friendlyMsg);
      setCameraActive(false);
      const perm = await cameraService.checkPermission();
      setActivePermission(perm);
    } finally {
      isStartingRef.current = false;
    }
  };

  /**
   * Inspects video track dimensions and device orientation.
   * Accurately orients the camera feed without double-rotation.
   */
  const inspectAndConfigureStreamOrientation = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    if (vw === 0 || vh === 0) return;

    const streamIsPortrait = vh >= vw;
    const screenIsPortrait = window.innerHeight >= window.innerWidth;
    setStreamDimensions({ width: vw, height: vh, isPortrait: streamIsPortrait });

    // Auto-detect if raw Android sensor is landscape on a portrait mobile phone
    if (!manualRotationSet) {
      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      if (isMobile && screenIsPortrait && !streamIsPortrait) {
        setFeedRotation(90);
      } else {
        // Stream is already portrait or desktop: Keep 0deg (prevents double rotation)
        setFeedRotation(0);
      }
    }
  };

  const stopCamera = () => {
    // Unlock screen orientation
    try {
      ScreenOrientation.unlock();
    } catch (e) {
      try {
        if (screen.orientation && 'unlock' in screen.orientation) {
          screen.orientation.unlock();
        }
      } catch (err) {}
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    cameraService.stopCamera(videoRef.current);
    setTorchEnabled(false);
    setHasTorch(false);
    setCameraActive(false);
    setAlignmentState('searching');
  };

  const toggleTorch = async () => {
    const nextState = !torchEnabled;
    const ok = await cameraService.setTorch(nextState);
    if (ok) {
      setTorchEnabled(nextState);
    }
  };

  const handleToggleCameraFacing = async () => {
    const nextFacing = activeFacingMode === 'environment' ? 'user' : 'environment';
    setActiveFacingMode(nextFacing);

    // Look for matching camera in available devices
    const matching = devices.find(d => 
      (nextFacing === 'user' && (d.label.toLowerCase().includes('front') || d.label.toLowerCase().includes('user'))) ||
      (nextFacing === 'environment' && (d.label.toLowerCase().includes('back') || d.label.toLowerCase().includes('rear') || d.label.toLowerCase().includes('environment')))
    );

    const targetId = matching ? matching.deviceId : '';
    setSelectedDeviceId(targetId);
    await startCamera(targetId);
  };

  const flipCamera = async () => {
    if (devices.length < 2) return;
    const currentIndex = devices.findIndex(d => d.deviceId === selectedDeviceId);
    const nextIndex = (currentIndex + 1) % devices.length;
    const nextDev = devices[nextIndex];
    setSelectedDeviceId(nextDev.deviceId);
    setActiveDeviceLabel(nextDev.label);
    await startCamera(nextDev.deviceId);
  };

  /**
   * Continuous Optical Analysis Loop for Automatic Capture
   */
  const startLiveScanningLoop = () => {
    let lastEvalTime = 0;

    const tick = async (timestamp: number) => {
      if (!videoRef.current || !cameraActive) return;

      const video = videoRef.current;
      if (video.videoWidth > 0 && video.videoHeight > 0 && !isProcessing && selectedQuiz) {
        // Fast alignment check every 220ms
        if (timestamp - lastEvalTime > 220) {
          lastEvalTime = timestamp;
          await evaluateLiveFrame();
        }
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);
  };

  /**
   * Evaluates the video frame for the 4 corner fiducials and stability.
   */
  const evaluateLiveFrame = async () => {
    if (!videoRef.current || isProcessing) return;
    const video = videoRef.current;

    // Cooldown check: wait 2.5 seconds after a capture before auto-capturing again
    const now = Date.now();
    if (now - lastCaptureTimeRef.current < 2500) {
      return;
    }

    try {
      // Lightweight analysis canvas downsampled for high-speed detection (< 6ms)
      const testCanvas = canvasRef.current || document.createElement('canvas');
      const scale = 0.5;
      const isRotated = feedRotation === 90 || feedRotation === 270;
      testCanvas.width = Math.round((isRotated ? video.videoHeight : video.videoWidth) * scale);
      testCanvas.height = Math.round((isRotated ? video.videoWidth : video.videoHeight) * scale);
      const ctx = testCanvas.getContext('2d');
      if (!ctx) return;

      if (feedRotation === 0) {
        ctx.drawImage(video, 0, 0, testCanvas.width, testCanvas.height);
      } else {
        ctx.save();
        ctx.translate(testCanvas.width / 2, testCanvas.height / 2);
        ctx.rotate((feedRotation * Math.PI) / 180);
        ctx.drawImage(
          video,
          -Math.round(video.videoWidth * scale) / 2,
          -Math.round(video.videoHeight * scale) / 2,
          Math.round(video.videoWidth * scale),
          Math.round(video.videoHeight * scale)
        );
        ctx.restore();
      }

      // Check for 4 optical corner markers
      const corners = findRegistrationCorners(ctx, testCanvas.width, testCanvas.height);

      if (corners) {
        // Check frame stability against last detected corners
        if (lastCornersRef.current) {
          const drift = 
            Math.hypot(corners.topLeft.x - lastCornersRef.current.tl.x, corners.topLeft.y - lastCornersRef.current.tl.y) +
            Math.hypot(corners.topRight.x - lastCornersRef.current.tr.x, corners.topRight.y - lastCornersRef.current.tr.y) +
            Math.hypot(corners.bottomRight.x - lastCornersRef.current.br.x, corners.bottomRight.y - lastCornersRef.current.br.y) +
            Math.hypot(corners.bottomLeft.x - lastCornersRef.current.bl.x, corners.bottomLeft.y - lastCornersRef.current.bl.y);

          // If corner drift is under threshold (< 20px on downsampled frame), increment stability counter
          if (drift < 20) {
            stableCountRef.current++;
          } else {
            stableCountRef.current = 1;
          }
        } else {
          stableCountRef.current = 1;
        }

        lastCornersRef.current = {
          tl: corners.topLeft,
          tr: corners.topRight,
          br: corners.bottomRight,
          bl: corners.bottomLeft,
        };

        const sharpness = measureSharpness(ctx, testCanvas.width, testCanvas.height);
        const isSharp = sharpness >= 45;

        // If stable for 2 consecutive evaluations (~440ms), sharp, and auto-capture enabled: TRIGGER!
        if (autoCaptureEnabled && stableCountRef.current >= 2 && isSharp) {
          setAlignmentState('stable');
          setScanStatusMessage('Sheet aligned! Capturing and grading...');
          lastCaptureTimeRef.current = Date.now();
          stableCountRef.current = 0;
          lastCornersRef.current = null;

          // Trigger full capture
          await captureAndProcessFrame(false);
        } else {
          setAlignmentState('detected');
          setScanStatusMessage('Sheet detected — Hold steady...');
        }
        return;
      }

      // If corners not found:
      stableCountRef.current = 0;
      lastCornersRef.current = null;
      setAlignmentState('searching');
      setScanStatusMessage('Align answer sheet with the 4 corner targets');
    } catch (e) {
      console.warn('Live frame evaluation note:', e);
    }
  };

  /**
   * Captures full-resolution frame from video or static image and executes OMR grading.
   */
  const captureAndProcessFrame = async (isManualTrigger: boolean = true) => {
    if (!videoRef.current || !selectedQuiz) return;
    const video = videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    try {
      setIsProcessing(true);
      setAlignmentState('capturing');

      // Vibrate mobile device upon capture
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate?.([60]);
      }

      const canvas = document.createElement('canvas');
      const isRotated = feedRotation === 90 || feedRotation === 270;
      canvas.width = isRotated ? video.videoHeight : video.videoWidth;
      canvas.height = isRotated ? video.videoWidth : video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (feedRotation === 0) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((feedRotation * Math.PI) / 180);
        ctx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2, video.videoWidth, video.videoHeight);
        ctx.restore();
      }
      const snapshotUrl = canvas.toDataURL('image/jpeg', 0.88);

      // Perform complete OMR recognition
      const result = await processOMRCanvas(
        canvas, 
        selectedQuiz.total_questions, 
        selectedQuiz.options_per_question
      );

      await handleScanCompleted(result, snapshotUrl);
    } catch (e) {
      console.error('Error during OMR processing:', e);
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Processes a successful sheet recognition: matches student, grades answers,
   * auto-saves if confident and unique, or opens Manual Review if attention is required.
   */
  const handleScanCompleted = async (data: ScannedSheetData, snapshotUrl: string) => {
    if (!selectedQuiz) return;

    // Audio cue
    if (soundEnabled) {
      playBeep();
    }

    const studentNum = (data.detectedStudentNumber || '').trim();
    const detectedLrn = (data.detectedLrn || '').trim();

    const isBlankStudentNum = !studentNum || studentNum === '00000' || /^0+$/.test(studentNum);
    const isBlankLrn = !detectedLrn || /^0+$/.test(detectedLrn);
    const isBlankId = isBlankStudentNum && isBlankLrn;

    // Unambiguous student matching:
    // 1. Never match blank or all-zero '00000' IDs
    // 2. If 12-digit LRN is detected, first match against s.lrn or s.student_number
    // 3. If standard 5-digit ID, match against s.student_number or s.lrn
    // 4. Require exactly 1 unique student match to avoid ever assigning results to the wrong student.
    let matchingStudents: Student[] = [];
    if (!isBlankId) {
      if (detectedLrn && detectedLrn.length >= 10) {
        matchingStudents = students.filter(s => {
          const sLrn = (s.lrn || '').trim();
          const sNum = (s.student_number || '').trim();
          return sLrn === detectedLrn || sNum === detectedLrn;
        });
      }
      if (matchingStudents.length === 0 && !isBlankStudentNum) {
        matchingStudents = students.filter(s => {
          const sNum = (s.student_number || '').trim();
          const sLrn = (s.lrn || '').trim();
          if (!sNum || /^0+$/.test(sNum)) return false;
          return sNum === studentNum || sNum.padStart(5, '0') === studentNum || sLrn === studentNum;
        });
      }
    }

    const found = matchingStudents.length === 1 ? matchingStudents[0] : null;

    // Check for duplicate submission in current quiz
    let isDuplicate = false;
    try {
      const existingResults = await db.getExamResults({ quizId: selectedQuiz.id });
      isDuplicate = existingResults.some(r => 
        (found && r.student_id === found.id) || 
        (!isBlankStudentNum && r.raw_student_number && (r.raw_student_number === studentNum || r.raw_student_number.padStart(5, '0') === studentNum)) ||
        (!isBlankLrn && r.raw_lrn && r.raw_lrn === detectedLrn)
      );
    } catch (err) {
      console.warn('Error checking existing exam results:', err);
    }

    // Grade against current quiz answer key
    const evalResult = gradeScannedAnswers(data.questions, selectedQuiz, answerKeys);

    // Quality gates: reject blurry, poorly lit, or misaligned scans
    if (data.isBlurry && !autoCaptureEnabled) {
      setScanStatusMessage('Scan was blurry. Please hold steady and try again.');
    }
    if (data.isPoorlyLit && !autoCaptureEnabled) {
      setScanStatusMessage('Lighting is too dark. Please use flash or improve lighting.');
    }

    // Criteria for automatic saving:
    // 1. Auto-save is enabled
    // 2. Exactly one unique student is matched and registered
    // 3. Student ID / LRN is not empty or dummy '00000'
    // 4. Overall confidence is high (>= 70%)
    // 5. Corners are cleanly detected and image is sharp and properly illuminated
    // 6. Not a duplicate submission
    // 7. No conflicting multiple marks
    const isCleanScan = !data.questions.some(q => q.isMultiple);
    const canAutoSave = 
      autoSaveEnabled && 
      found !== null && 
      !isBlankId && 
      !data.isBlurry &&
      !data.isPoorlyLit &&
      data.cornersDetected &&
      data.overallConfidence >= 70 && 
      !isDuplicate && 
      isCleanScan;

    if (canAutoSave) {
      // Automatic Record Saving without stopping
      await executeSaveExamResult(
        found.id,
        studentNum || null,
        detectedLrn || (studentNum.length >= 10 ? studentNum : null),
        snapshotUrl,
        evalResult,
        data.overallConfidence,
        false
      );

      // Display floating Auto-Save feedback toast
      setAutoSaveToast({
        studentName: `${found.last_name}, ${found.first_name}`,
        studentNumber: studentNum || detectedLrn,
        score: evalResult.totalScore,
        maxScore: evalResult.maxScore,
        percentage: evalResult.percentage,
        passed: evalResult.passed,
      });

      // Perfect score celebration
      if (evalResult.percentage === 100) {
        confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      }

      // Hide toast after 3.5 seconds
      setTimeout(() => {
        setAutoSaveToast(null);
      }, 3500);

      setAlignmentState('searching');
      setScanStatusMessage(`Auto-saved: ${found.last_name} (${evalResult.percentage}%). Ready for next sheet.`);
    } else {
      // Require Manual Review
      setScanResult(data);
      setScannedImageUrl(snapshotUrl);
      setReviewQuestions([...data.questions]);
      setMatchedStudent(found || null);
      setManualStudentId(found ? found.id : '');
      setEvaluation(evalResult);

      const displayIdentifier = detectedLrn || studentNum || 'Blank';
      if (isDuplicate) {
        setDuplicateWarning(`Warning: Student (${found ? `${found.last_name}, ${found.first_name}` : displayIdentifier}) already has a submitted score for this exam!`);
      } else if (matchingStudents.length > 1) {
        setDuplicateWarning(`Ambiguous match: Multiple students share identifier #${displayIdentifier}. Please manually select the correct student below.`);
      } else if (isBlankId) {
        setDuplicateWarning(`No Student ID or LRN bubbled on sheet. Please manually select the student from the roster below.`);
      } else if (!found) {
        setDuplicateWarning(`Identifier #${displayIdentifier} was not found in the student roster. Please assign or register student below.`);
      } else if (!isCleanScan) {
        setDuplicateWarning(`Review required: Paper contains multiple markings on one or more items.`);
      } else {
        setDuplicateWarning(null);
      }

      setIsReviewOpen(true);
    }
  };

  /**
   * Persists the exam result to Supabase / Gradebook database.
   */
  const executeSaveExamResult = async (
    targetStudentId: string | null,
    studentNumber: string | null,
    lrn: string | null,
    imageUrl: string | null,
    evalResult: GradingEvaluation,
    confidence: number,
    needsReview: boolean
  ) => {
    if (!selectedQuiz || isSavingRef.current) return;
    isSavingRef.current = true;

    try {
      const saved = await db.saveExamResult({
        quiz_id: selectedQuiz.id,
        student_id: targetStudentId,
        teacher_id: selectedQuiz.teacher_id || '',
        raw_student_number: studentNumber,
        raw_lrn: lrn,
        scanned_image_url: imageUrl,
        total_score: evalResult.totalScore,
        max_score: evalResult.maxScore,
        percentage: evalResult.percentage,
        correct_count: evalResult.correctCount,
        incorrect_count: evalResult.incorrectCount,
        unanswered_count: evalResult.unansweredCount,
        passed: evalResult.passed,
        scan_confidence: confidence || 95,
        needs_review: needsReview,
      }, evalResult.itemResults.map(item => ({
        question_number: item.questionNumber,
        marked_options: item.marked,
        correct_options: item.correct,
        is_correct: item.isCorrect,
        points_awarded: item.pointsAwarded,
        confidence: item.confidence,
        is_blank: item.isBlank,
        is_multiple: item.isMultiple,
      })));

      // Add to session tally list
      const matched = students.find(s => s.id === targetStudentId);
      const newRecord: SessionScannedRecord = {
        id: saved.id || `session_${Date.now()}`,
        studentName: matched ? `${matched.last_name}, ${matched.first_name}` : `Student #${studentNumber || lrn || 'Unassigned'}`,
        studentNumber: studentNumber || lrn || 'N/A',
        totalScore: evalResult.totalScore,
        maxScore: evalResult.maxScore,
        percentage: evalResult.percentage,
        passed: evalResult.passed,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setSessionRecords(prev => [newRecord, ...prev]);
    } catch (e: any) {
      console.error('Error saving exam result:', e);
      throw e;
    } finally {
      isSavingRef.current = false;
    }
  };

  const handleManualSave = async () => {
    if (!selectedQuiz || !evaluation || savingResult || isSavingRef.current) return;

    try {
      setSavingResult(true);
      const targetStudentId = manualStudentId || matchedStudent?.id || null;

      await executeSaveExamResult(
        targetStudentId,
        scanResult?.detectedStudentNumber || null,
        scanResult?.detectedLrn || null,
        scannedImageUrl,
        evaluation,
        scanResult?.overallConfidence || 95,
        reviewQuestions.some(q => q.isMultiple || q.confidence < 50)
      );

      if (evaluation.percentage === 100) {
        confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      }

      setIsReviewOpen(false);
      setScanStatusMessage(`Saved result for ${matchedStudent ? matchedStudent.last_name : 'Student'} (${evaluation.percentage}%).`);
    } catch (err: any) {
      alert('Error saving exam result: ' + err.message);
    } finally {
      setSavingResult(false);
    }
  };

  /**
   * Runs the automated OMR Calibration Benchmark across 20 ground-truth questions.
   */
  const handleRunCalibration = async () => {
    try {
      setIsCalibrating(true);
      setScanStatusMessage('Running OMR Calibration Benchmark across upright, rotated, and shadowed sheets...');
      const metrics = await runCalibrationBenchmark();
      setCalibrationMetrics(metrics);
      setShowCalibrationModal(true);
    } catch (err: any) {
      alert('Calibration benchmark error: ' + err.message);
    } finally {
      setIsCalibrating(false);
    }
  };

  /**
   * Static photo upload handler.
   */
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedQuiz) return;

    const img = new Image();
    const reader = new FileReader();

    reader.onload = (event) => {
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(img, 0, 0);
        const snapshotUrl = canvas.toDataURL('image/jpeg', 0.88);

        try {
          setIsProcessing(true);
          const result = await processOMRCanvas(
            canvas, 
            selectedQuiz.total_questions, 
            selectedQuiz.options_per_question
          );
          await handleScanCompleted(result, snapshotUrl);
        } catch (err: any) {
          alert('OMR recognition error: ' + err.message);
        } finally {
          setIsProcessing(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  /**
   * Simulates scanning a pre-marked test sheet for immediate verification.
   * Supports testing both 5-digit Student ID and 12-digit DepEd LRN sheets.
   */
  const handleScanSampleSheet = async (mode: 'student_id_5' | 'lrn_12' = 'student_id_5') => {
    if (!selectedQuiz) return;
    try {
      setIsProcessing(true);
      setScanStatusMessage(`Synthesizing sample ${mode === 'lrn_12' ? '12-Digit LRN' : '5-Digit ID'} sheet & running OMR engine...`);
      const canvas = document.createElement('canvas');
      canvas.width = CANONICAL_WIDTH;
      canvas.height = CANONICAL_HEIGHT;

      // Draw high-resolution answer sheet directly
      const qOptionsCount = selectedQuiz.options_per_question || 4;
      await renderAnswerSheetToCanvas(canvas, {
        title: selectedQuiz.title,
        className: selectedQuiz.class_name || 'Physics Alpha',
        examDate: selectedQuiz.exam_date,
        totalQuestions: selectedQuiz.total_questions,
        optionsCount: qOptionsCount,
        quizId: selectedQuiz.id,
        idMode: mode,
      });

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (mode === 'lrn_12') {
        // Mark Student Alexander Wright's LRN: 109283746501
        const idBubbles = getStudentIdBubbleCoordinates('lrn_12');
        const demoLrnDigits = [1, 0, 9, 2, 8, 3, 7, 4, 6, 5, 0, 1];
        for (let col = 0; col < 12; col++) {
          const targetDigit = demoLrnDigits[col];
          const bubble = idBubbles.find(b => b.digitColumn === col && b.digitValue === targetDigit);
          if (bubble) {
            const bx = bubble.normX * CANONICAL_WIDTH;
            const by = bubble.normY * CANONICAL_HEIGHT;
            const br = bubble.normRadius * CANONICAL_WIDTH;
            ctx.beginPath();
            ctx.arc(bx, by, br * 0.78, 0, Math.PI * 2);
            ctx.fillStyle = '#1e293b';
            ctx.fill();
          }
        }
      } else {
        // Mark Student ID 10001 (Column 0: 1, Column 1: 0, Column 2: 0, Column 3: 0, Column 4: 1)
        const idBubbles = getStudentIdBubbleCoordinates('student_id_5');
        const demoIdDigits = [1, 0, 0, 0, 1];
        for (let col = 0; col < 5; col++) {
          const targetDigit = demoIdDigits[col];
          const bubble = idBubbles.find(b => b.digitColumn === col && b.digitValue === targetDigit);
          if (bubble) {
            const bx = bubble.normX * CANONICAL_WIDTH;
            const by = bubble.normY * CANONICAL_HEIGHT;
            const br = bubble.normRadius * CANONICAL_WIDTH;
            ctx.beginPath();
            ctx.arc(bx, by, br * 0.78, 0, Math.PI * 2);
            ctx.fillStyle = '#1e293b';
            ctx.fill();
          }
        }
      }

      // Mark question bubbles
      const qBubbles = getQuestionBubbleCoordinates(selectedQuiz.total_questions, qOptionsCount);
      for (let q = 1; q <= selectedQuiz.total_questions; q++) {
        const key = answerKeys.find(k => k.question_number === q);
        let chosenOpt = key?.correct_options[0] || 'A';
        // Add 2 realistic student errors for realistic grading
        if (q === 4) chosenOpt = chosenOpt === 'A' ? 'B' : 'A';
        if (q === 11) chosenOpt = chosenOpt === 'C' ? 'D' : 'B';

        const b = qBubbles.find(item => item.questionNumber === q && item.optionLabel === chosenOpt);
        if (b) {
          const bx = b.normX * CANONICAL_WIDTH;
          const by = b.normY * CANONICAL_HEIGHT;
          const br = b.normRadius * CANONICAL_WIDTH;
          ctx.beginPath();
          ctx.arc(bx, by, br * 0.78, 0, Math.PI * 2);
          ctx.fillStyle = '#1e293b';
          ctx.fill();
        }
      }

      const snapshotUrl = canvas.toDataURL('image/jpeg', 0.9);
      const result = await processOMRCanvas(canvas, selectedQuiz.total_questions, qOptionsCount);
      await handleScanCompleted(result, snapshotUrl);
    } catch (err: any) {
      alert('Sample test sheet scanning error: ' + err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Color-coded answer override toggle.
   */
  const handleToggleOptionOverride = (qNumber: number, option: string) => {
    if (!selectedQuiz) return;

    setReviewQuestions(prev => {
      const updated = prev.map(q => {
        if (q.questionNumber !== qNumber) return q;
        const newMarked = q.markedOptions.includes(option)
          ? q.markedOptions.filter(o => o !== option)
          : [option];
        return {
          ...q,
          markedOptions: newMarked,
          isBlank: newMarked.length === 0,
          isMultiple: newMarked.length > 1,
          needsReview: false,
          confidence: 100,
        };
      });

      const newEval = gradeScannedAnswers(updated, selectedQuiz, answerKeys);
      setEvaluation(newEval);
      return updated;
    });
  };

  const playBeep = () => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) {
      // AudioContext policy fallback
    }
  };

  // Dynamic corner guide styling based on live alignment state
  const cornerColor = 
    alignmentState === 'stable' || alignmentState === 'capturing'
      ? 'border-emerald-400 drop-shadow-[0_0_12px_rgba(52,211,153,0.9)]'
      : alignmentState === 'detected'
      ? 'border-teal-400 drop-shadow-[0_0_6px_rgba(45,212,191,0.6)]'
      : 'border-slate-500/70';

  const statusDot = 
    alignmentState === 'stable' || alignmentState === 'capturing'
      ? 'bg-emerald-400'
      : alignmentState === 'detected'
      ? 'bg-teal-400'
      : 'bg-amber-400';

  const isRotated90 = feedRotation === 90 || feedRotation === 270;

  return (
    <div className="space-y-4 max-w-lg mx-auto pb-12 px-2 sm:px-0">
      {/* 1. Top Bar: Active Exam Selector & Quick Settings */}
      <div className="flex items-center justify-between gap-2.5 pt-1">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Badge variant="teal" size="sm" className="shrink-0 font-extrabold tracking-wider">
            EXAM
          </Badge>
          <select
            value={selectedQuiz?.id || ''}
            onChange={(e) => {
              const found = quizzes.find(q => q.id === e.target.value);
              if (found) setSelectedQuiz(found);
            }}
            className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-300 dark:border-slate-700 font-bold bg-white dark:bg-slate-900 focus:ring-2 focus:ring-brand-500 truncate shadow-sm text-slate-800 dark:text-slate-100"
          >
            {quizzes.map(q => (
              <option key={q.id} value={q.id}>
                {q.title} ({q.total_questions} Qs • Pass {q.passing_percentage}%)
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="outline" size="sm" className="font-extrabold text-[11px] text-slate-600 dark:text-slate-300">
            {sessionRecords.length} Graded
          </Badge>
        </div>
      </div>

      {/* 2. TALL PORTRAIT SCANNING VIEWPORT (ZipGrade-Style) */}
      {/* Strictly taller than it is wide; fills available vertical space without stretching */}
      <div
        ref={containerRef}
        className={
          isFullScreen && cameraActive
            ? "fixed inset-0 z-50 bg-black flex flex-col justify-between overflow-hidden select-none"
            : "relative w-full aspect-[3/4] sm:aspect-[9/16] min-h-[480px] max-h-[76vh] rounded-3xl overflow-hidden bg-slate-950 shadow-2xl border-4 border-slate-800 flex items-center justify-center select-none"
        }
      >
        {/* Continuous Video Feed Element - Kept permanently mounted to prevent ref deadlock */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          onLoadedMetadata={inspectAndConfigureStreamOrientation}
          style={
            cameraActive
              ? isRotated90
                ? {
                    width: containerSize.height ? `${containerSize.height}px` : '100%',
                    height: containerSize.width ? `${containerSize.width}px` : '100%',
                    transform: `rotate(${feedRotation}deg)`,
                    objectFit: isFullScreen ? 'cover' : 'contain',
                  }
                : {
                    width: '100%',
                    height: '100%',
                    transform: feedRotation === 180 ? 'rotate(180deg)' : 'none',
                    objectFit: isFullScreen ? 'cover' : 'contain',
                  }
              : { display: 'none' }
          }
          className={`transition-transform duration-200 ${
            cameraActive
              ? isFullScreen ? 'absolute inset-0 w-full h-full object-cover' : 'w-full h-full object-contain'
              : 'hidden'
          }`}
        />
        <canvas ref={canvasRef} className="hidden" />

        {cameraActive ? (
          <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
            {/* Viewfinder Overlaid Top Header Bar */}
            <div className="absolute top-0 inset-x-0 z-20 flex items-center justify-between p-3 bg-gradient-to-b from-black/85 via-black/40 to-transparent">
              {/* Stream Resolution & Orientation Badge */}
              <div className="px-2.5 py-1 rounded-full bg-slate-900/85 backdrop-blur-md border border-slate-700/80 text-[10px] font-mono text-slate-300 font-bold flex items-center gap-1.5 shadow-md">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>
                  {streamDimensions.width ? `${streamDimensions.width}×${streamDimensions.height}` : 'Live'}
                  {feedRotation !== 0 && ` (${feedRotation}°)`}
                </span>
              </div>

              {/* Utility Tools: Diagnostics, Torch, Rotate, Flip, Mute, Fullscreen */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowDiagnosticsModal(true)}
                  className="p-2 rounded-full bg-slate-900/80 backdrop-blur-md text-white border border-slate-700 hover:bg-slate-800 transition-colors shadow-lg"
                  title="Camera Diagnostics & Hardware Info"
                >
                  <Activity className="w-4 h-4 text-brand-400" />
                </button>

                {hasTorch && (
                  <button
                    type="button"
                    onClick={toggleTorch}
                    className={`p-2 rounded-full backdrop-blur-md border transition-colors shadow-lg ${
                      torchEnabled
                        ? 'bg-amber-500 text-black border-amber-400'
                        : 'bg-slate-900/80 text-white border-slate-700 hover:bg-slate-800'
                    }`}
                    title="Toggle Torch / Flashlight"
                  >
                    <Zap className="w-4 h-4" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    const nextAngle = ((feedRotation + 90) % 360) as 0 | 90 | 180 | 270;
                    setFeedRotation(nextAngle);
                    setManualRotationSet(true);
                  }}
                  className="p-2 rounded-full bg-slate-900/80 backdrop-blur-md text-white border border-slate-700 hover:bg-slate-800 transition-colors shadow-lg flex items-center gap-1"
                  title={`Adjust Feed Orientation (Current: ${feedRotation}°)`}
                >
                  <RotateCw className="w-4 h-4 text-brand-400" />
                </button>

                {devices.length > 1 && (
                  <button
                    type="button"
                    onClick={handleToggleCameraFacing}
                    className="p-2 rounded-full bg-slate-900/80 backdrop-blur-md text-white border border-slate-700 hover:bg-slate-800 transition-colors shadow-lg"
                    title={`Switch to ${activeFacingMode === 'environment' ? 'Front' : 'Rear'} Camera`}
                  >
                    <SwitchCamera className="w-4 h-4 text-brand-400" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setIsFullScreen(!isFullScreen)}
                  className="p-2 rounded-full bg-slate-900/80 backdrop-blur-md text-white border border-slate-700 hover:bg-slate-800 transition-colors shadow-lg"
                  title={isFullScreen ? 'Exit Fullscreen' : 'Fullscreen Viewfinder'}
                >
                  {isFullScreen ? <Minimize2 className="w-4 h-4 text-brand-400" /> : <Maximize2 className="w-4 h-4 text-brand-400" />}
                </button>

                <button
                  type="button"
                  onClick={() => setSoundEnabled(!soundEnabled)}
                  className="p-2 rounded-full bg-slate-900/80 backdrop-blur-md text-white border border-slate-700 hover:bg-slate-800 transition-colors shadow-lg"
                  title={soundEnabled ? 'Mute Audio' : 'Unmute Audio'}
                >
                  {soundEnabled ? <Volume2 className="w-4 h-4 text-brand-400" /> : <VolumeX className="w-4 h-4 text-slate-400" />}
                </button>
              </div>
            </div>

            {/* Centered Portrait A4 Scanning Guide (Proportions: 210 x 297 mm) */}
            <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none z-10">
              <div
                style={{ aspectRatio: '210 / 297' }}
                className="relative w-[84%] max-w-[320px] max-h-[72%] rounded-2xl border-2 border-dashed border-white/40 flex flex-col justify-between p-2.5 sm:p-3 transition-all duration-300 shadow-[0_0_60px_rgba(0,0,0,0.65)]"
              >
                {/* 4 Optical Corner Target Brackets */}
                <div className="flex justify-between items-start">
                  <div className={`w-10 h-10 sm:w-14 sm:h-14 border-t-4 border-l-4 rounded-tl-xl transition-all duration-300 ${cornerColor}`} />
                  <div className={`w-10 h-10 sm:w-14 sm:h-14 border-t-4 border-r-4 rounded-tr-xl transition-all duration-300 ${cornerColor}`} />
                </div>

                {/* Center Guidance Laser Line & Status Pill */}
                <div className="self-center flex flex-col items-center gap-1.5">
                  {alignmentState === 'searching' && (
                    <div className="w-32 sm:w-44 h-0.5 bg-brand-400/90 shadow-[0_0_12px_rgba(20,184,166,0.9)] animate-pulse" />
                  )}
                  <div className="px-3 py-1.5 rounded-full bg-slate-950/90 backdrop-blur-md border border-slate-700 text-xs font-bold text-slate-100 flex items-center gap-2 shadow-2xl">
                    <span className={`w-2.5 h-2.5 rounded-full ${statusDot} animate-pulse`} />
                    <span className="truncate max-w-[190px] sm:max-w-xs">{scanStatusMessage}</span>
                  </div>
                </div>

                {/* Bottom Corners */}
                <div className="flex justify-between items-end">
                  <div className={`w-10 h-10 sm:w-14 sm:h-14 border-b-4 border-l-4 rounded-bl-xl transition-all duration-300 ${cornerColor}`} />
                  <div className={`w-10 h-10 sm:w-14 sm:h-14 border-b-4 border-r-4 rounded-br-xl transition-all duration-300 ${cornerColor}`} />
                </div>
              </div>
            </div>

            {/* Floating Auto-Save Toast Overlay */}
            {autoSaveToast && (
              <div className="absolute top-16 inset-x-3 sm:inset-x-6 p-3 rounded-2xl bg-emerald-950/95 backdrop-blur-md border border-emerald-400 text-white shadow-2xl z-30 flex items-center justify-between animate-fadeIn">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-full bg-emerald-500 flex items-center justify-center font-black text-xs text-slate-950">
                    {autoSaveToast.percentage}%
                  </div>
                  <div>
                    <p className="font-extrabold text-xs flex items-center gap-1 text-emerald-100">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      Auto-Saved: {autoSaveToast.studentName}
                    </p>
                    <p className="text-[10px] text-emerald-300">
                      Score: {autoSaveToast.score}/{autoSaveToast.maxScore} • {autoSaveToast.studentNumber ? `ID #${autoSaveToast.studentNumber}` : 'Matched'}
                    </p>
                  </div>
                </div>
                <Badge variant={autoSaveToast.passed ? 'success' : 'danger'} size="sm">
                  {autoSaveToast.passed ? 'PASSED' : 'FAILED'}
                </Badge>
              </div>
            )}

            {/* Fullscreen Overlay Bottom Floating Control Bar */}
            {isFullScreen && (
              <div className="absolute bottom-0 inset-x-0 z-20 flex items-center justify-between p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setIsFullScreen(false);
                    stopCamera();
                  }}
                  leftIcon={<X className="w-4 h-4 text-red-500" />}
                  className="text-xs bg-black/60 border-slate-700 text-white font-bold"
                >
                  Close
                </Button>

                {/* Shutter Button */}
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => captureAndProcessFrame(true)}
                  className="w-16 h-16 rounded-full bg-brand-700 hover:bg-brand-600 border-4 border-brand-200 flex items-center justify-center p-1 shadow-2xl active:scale-95 transition-all disabled:opacity-50"
                  title="Capture & Grade Now"
                >
                  <div className="w-13 h-13 rounded-full bg-white flex items-center justify-center shadow-inner">
                    <ScanLine className="w-7 h-7 text-brand-800" />
                  </div>
                </button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsFullScreen(false)}
                  leftIcon={<Minimize2 className="w-4 h-4 text-brand-400" />}
                  className="text-xs bg-black/60 border-slate-700 text-white font-bold"
                >
                  Minimize
                </Button>
              </div>
            )}
          </div>
        ) : (
          /* Camera Standby Screen when Inactive */
          <div className="p-8 text-center space-y-4 text-slate-400 z-10 flex flex-col items-center justify-center h-full">
            <div className="w-20 h-20 rounded-3xl bg-brand-950/60 border border-brand-700/60 mx-auto flex items-center justify-center text-brand-400 shadow-inner">
              <Camera className="w-10 h-10" />
            </div>
            <div>
              <h3 className="text-lg font-extrabold text-slate-100">Camera Inactive</h3>
              <p className="text-xs text-slate-400 max-w-xs mx-auto mt-1 leading-relaxed">
                Start the live camera or inspect camera diagnostics to verify browser permissions.
              </p>
            </div>
            {cameraError && (
              <div className="p-3 bg-red-950/60 border border-red-800 text-red-200 rounded-xl text-xs max-w-xs mx-auto text-left">
                <p className="font-bold flex items-center gap-1">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  Camera Attention Required
                </p>
                <p className="text-[11px] mt-1 opacity-90">{cameraError}</p>
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="primary"
                size="lg"
                onClick={() => startCamera()}
                leftIcon={<Camera className="w-5 h-5" />}
                className="shadow-xl shadow-brand-900/40 text-sm font-bold"
              >
                Start Camera Scanner
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => setShowDiagnosticsModal(true)}
                leftIcon={<Activity className="w-5 h-5 text-brand-400" />}
                className="text-sm font-bold bg-slate-900/70 border-slate-700 text-slate-200"
              >
                Diagnostics
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 3. CAPTURE & SCANNING CONTROLS BAR (ZipGrade Action Bar) */}
      <div className="w-full space-y-3">
        {/* Toggles Pill */}
        <div className="flex items-center justify-between px-4 py-2 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs shadow-sm">
          <label className="flex items-center gap-1.5 cursor-pointer font-medium text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={autoCaptureEnabled}
              onChange={(e) => setAutoCaptureEnabled(e.target.checked)}
              className="w-4 h-4 rounded text-brand-600 focus:ring-brand-500"
            />
            <Zap className="w-3.5 h-3.5 text-amber-500" />
            <span>Auto-Capture</span>
          </label>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <label className="flex items-center gap-1.5 cursor-pointer font-medium text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={autoSaveEnabled}
              onChange={(e) => setAutoSaveEnabled(e.target.checked)}
              className="w-4 h-4 rounded text-brand-600 focus:ring-brand-500"
            />
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
            <span>Auto-Save</span>
          </label>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <span className="text-brand-700 dark:text-brand-400 font-extrabold text-[11px]">
            {sessionRecords.length} Saved
          </span>
        </div>

        {/* Primary Action Buttons: Stop Camera, Large Shutter, Upload */}
        <div className="flex items-center justify-between gap-3">
          {/* Stop / Start Camera Button */}
          {cameraActive ? (
            <Button
              variant="outline"
              size="md"
              onClick={stopCamera}
              leftIcon={<X className="w-4 h-4 text-red-500" />}
              className="flex-1 text-xs border-slate-300 dark:border-slate-700 font-bold"
            >
              Stop Camera
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              onClick={() => startCamera()}
              leftIcon={<Camera className="w-4 h-4" />}
              className="flex-1 text-xs font-bold"
            >
              Start Camera
            </Button>
          )}

          {/* Prominent ZipGrade-Style Center Shutter Button */}
          <button
            type="button"
            disabled={isProcessing || !cameraActive}
            onClick={() => captureAndProcessFrame(true)}
            className="w-16 h-16 sm:w-18 sm:h-18 rounded-full bg-brand-700 hover:bg-brand-600 border-4 border-brand-200 dark:border-brand-800 flex items-center justify-center p-1 shadow-xl active:scale-95 transition-all disabled:opacity-50 disabled:scale-100"
            title="Capture & Grade Now"
          >
            <div className="w-13 h-13 sm:w-15 sm:h-15 rounded-full bg-white flex items-center justify-center shadow-inner">
              <ScanLine className="w-7 h-7 text-brand-800" />
            </div>
          </button>

          {/* Upload Photo Button */}
          <Button
            variant="outline"
            size="md"
            onClick={() => fileInputRef.current?.click()}
            leftIcon={<Upload className="w-4 h-4 text-brand-600" />}
            className="flex-1 text-xs border-slate-300 dark:border-slate-700 font-bold"
          >
            Upload Photo
          </Button>
          <input
            type="file"
            ref={fileInputRef}
            accept="image/*"
            className="hidden"
            onChange={handleFileUpload}
          />
        </div>
      </div>

      {/* 4. QUICK TEST & SESSION HISTORY (Directly below Controls) */}
      <div className="w-full space-y-3 pt-1">
        <div className="flex items-center justify-between gap-2 p-2.5 rounded-2xl bg-slate-100 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-xs">
          <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-400 font-medium">
            <Sparkles className="w-4 h-4 text-brand-600" />
            <span>Test OMR Engine:</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => handleScanSampleSheet('student_id_5')} className="text-xs h-7 px-2 font-bold text-brand-700 dark:text-brand-300">
              5-Digit ID
            </Button>
            <span className="text-slate-400">•</span>
            <Button variant="ghost" size="sm" onClick={() => handleScanSampleSheet('lrn_12')} className="text-xs h-7 px-2 font-bold text-teal-700 dark:text-teal-300">
              12-Digit LRN
            </Button>
            <span className="text-slate-400">•</span>
            <Button 
              variant="ghost" 
              size="sm" 
              isLoading={isCalibrating}
              onClick={handleRunCalibration} 
              className="text-xs h-7 px-2 font-bold text-indigo-700 dark:text-indigo-300"
            >
              Accuracy Benchmark
            </Button>
          </div>
        </div>

        {/* Session Graded Papers List */}
        {sessionRecords.length > 0 && (
          <Card>
            <CardHeader
              action={
                <Badge variant="teal" size="sm">
                  {sessionRecords.length} Graded
                </Badge>
              }
            >
              <CardTitle className="text-xs flex items-center gap-2">
                <Layers className="w-4 h-4 text-brand-700" />
                Session History
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                {sessionRecords.map((rec) => (
                  <div
                    key={rec.id}
                    className="p-2 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs bg-slate-50/50 dark:bg-slate-900/50"
                  >
                    <div>
                      <p className="font-bold text-slate-800 dark:text-slate-200">{rec.studentName}</p>
                      <p className="text-[11px] text-slate-500">ID #{rec.studentNumber} • {rec.timestamp}</p>
                    </div>
                    <div className="text-right">
                      <span className={`font-black ${rec.passed ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {rec.percentage}%
                      </span>
                      <p className="text-[10px] text-slate-400">{rec.totalScore}/{rec.maxScore} pts</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ========================================================================= */}
      {/* VISUAL VERIFICATION & MANUAL REVIEW MODAL                                  */}
      {/* ========================================================================= */}
      <Modal
        isOpen={isReviewOpen}
        onClose={() => setIsReviewOpen(false)}
        title="Verify Scanned Exam Sheet"
        description="Review detected bubble answers, confirm student match, or tap any bubble to override."
        maxWidth="4xl"
      >
        {evaluation && (
          <div className="space-y-5">
            {/* Warning Banner if Unmatched, Duplicate, or Low Confidence */}
            {duplicateWarning && (
              <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-100 flex items-start gap-2.5 text-xs">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold">{duplicateWarning}</p>
                  <p className="text-[11px] text-amber-800 dark:text-amber-300 mt-0.5">
                    Please confirm student assignment and verify marked responses before recording.
                  </p>
                </div>
              </div>
            )}

            {/* Top Score Banner */}
            <div className={`p-4 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 ${
              evaluation.passed 
                ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100' 
                : 'bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-100'
            }`}>
              <div className="flex items-center gap-3.5">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center font-black text-2xl text-white shadow-md ${evaluation.passed ? 'bg-emerald-600' : 'bg-rose-600'}`}>
                  {evaluation.percentage}%
                </div>
                <div>
                  <h3 className="font-black text-lg">
                    Score: {evaluation.totalScore} / {evaluation.maxScore} points
                  </h3>
                  <div className="flex flex-wrap items-center gap-3 text-xs mt-1">
                    <span className="flex items-center gap-1 font-bold text-emerald-700 dark:text-emerald-300">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
                      Correct: {evaluation.correctCount}
                    </span>
                    <span className="flex items-center gap-1 font-bold text-rose-700 dark:text-rose-300">
                      <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" />
                      Incorrect: {evaluation.incorrectCount}
                    </span>
                    <span className="flex items-center gap-1 font-bold text-slate-600 dark:text-slate-400">
                      <span className="w-2.5 h-2.5 rounded-full bg-slate-400 inline-block" />
                      Unanswered: {evaluation.unansweredCount}
                    </span>
                  </div>
                </div>
              </div>
              <Badge variant={evaluation.passed ? 'success' : 'danger'} size="md">
                {evaluation.passed ? 'PASSED' : 'FAILED'}
              </Badge>
            </div>

            {/* Student Matching Section */}
            <div className="p-3.5 bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <UserCheck className="w-4 h-4 text-brand-600 shrink-0" />
                <span className="font-semibold text-slate-700 dark:text-slate-300">
                  Detected ID: <span className="font-mono font-bold text-brand-700 dark:text-brand-400">#{scanResult?.detectedStudentNumber || 'N/A'}</span>
                </span>
                {scanResult?.detectedLrn && (
                  <span className="font-mono text-[10px] bg-brand-50 dark:bg-brand-950/60 text-brand-700 dark:text-brand-300 font-bold px-2 py-0.5 rounded border border-brand-200 dark:border-brand-800">
                    LRN: {scanResult.detectedLrn}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <span className="text-slate-500 font-bold shrink-0">Assign to Student:</span>
                <select
                  value={manualStudentId || matchedStudent?.id || ''}
                  onChange={(e) => {
                    setManualStudentId(e.target.value);
                    const s = students.find(item => item.id === e.target.value);
                    setMatchedStudent(s || null);
                  }}
                  className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-bold focus:ring-2 focus:ring-brand-500 max-w-xs"
                >
                  <option value="">-- Unassigned / Guest Student --</option>
                  {students.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.last_name}, {s.first_name} (#{s.student_number}{s.lrn ? ` • LRN: ${s.lrn}` : ''})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Visual Sheet Verification (Captured vs Rectified Canonical Sheet) */}
            <div className="p-3.5 bg-slate-950 rounded-2xl border border-slate-800 text-white space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-teal-400" />
                  <span className="text-xs font-bold text-slate-200">Visual Verification (Captured vs Rectified Sheet)</span>
                </div>
                <div className="flex items-center gap-2">
                  {scanResult?.cornersDetected ? (
                    <Badge variant="teal" size="sm" className="font-bold text-[10px]">
                      <Check className="w-3 h-3 mr-1 inline" /> 4 Corners Rectified
                    </Badge>
                  ) : (
                    <Badge variant="warning" size="sm" className="font-bold text-[10px]">
                      Direct Scaled (No Markers Detected)
                    </Badge>
                  )}
                  <span className="text-[11px] font-mono text-slate-400">
                    Confidence: {scanResult?.overallConfidence}%
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                {/* Captured Frame Thumbnail */}
                {scannedImageUrl && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                      Captured Camera Frame
                    </p>
                    <div className="relative rounded-xl overflow-hidden border border-slate-800 bg-black aspect-[3/4] max-h-48 flex items-center justify-center">
                      <img
                        src={scannedImageUrl}
                        alt="Captured Paper Frame"
                        className="w-full h-full object-contain"
                      />
                    </div>
                  </div>
                )}

                {/* Rectified Canonical Canvas Preview */}
                {scanResult?.warpedCanvas && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase font-bold text-teal-400 tracking-wider">
                      Perspective-Corrected Canonical Sheet
                    </p>
                    <div className="relative rounded-xl overflow-hidden border border-teal-500/40 bg-black aspect-[3/4] max-h-48 flex items-center justify-center">
                      <img
                        src={scanResult.warpedCanvas.toDataURL('image/jpeg', 0.85)}
                        alt="Rectified Canonical Sheet"
                        className="w-full h-full object-contain"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Item-by-Item Review Grid with Color-Coded Answers */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
                  Item Analysis & Answers
                </h4>
                {/* Color Legend */}
                <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-slate-600 dark:text-slate-400">
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 inline-block" /> Correct
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-600 inline-block" /> Wrong
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full border-2 border-dashed border-amber-500 bg-amber-100 inline-block" /> Key
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-slate-400 inline-block" /> Blank
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5 max-h-72 overflow-y-auto p-1">
                {evaluation.itemResults.map((item) => {
                  const optionLetters = ['A', 'B', 'C', 'D', 'E'].slice(0, selectedQuiz?.options_per_question || 4);

                  return (
                    <div
                      key={item.questionNumber}
                      className={`p-2.5 rounded-xl border text-xs transition-all ${
                        item.isCorrect
                          ? 'border-emerald-300 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-950 dark:text-emerald-100'
                          : item.isMultiple
                          ? 'border-purple-300 bg-purple-50/70 dark:bg-purple-950/30 text-purple-950 dark:text-purple-100'
                          : item.isBlank
                          ? 'border-slate-300 bg-slate-50 dark:bg-slate-800/40 text-slate-700 dark:text-slate-300'
                          : 'border-rose-300 bg-rose-50/70 dark:bg-rose-950/30 text-rose-950 dark:text-rose-100'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5 font-bold">
                        <div className="flex items-center gap-1 flex-wrap">
                          <span>Q{item.questionNumber}.</span>
                          {item.isCorrect && <span className="text-[10px] text-emerald-600 font-black">✔</span>}
                          {!item.isCorrect && !item.isBlank && <span className="text-[10px] text-rose-600 font-black">✘</span>}
                          {item.isMultiple && <span className="text-[8px] px-1 rounded bg-purple-200 dark:bg-purple-900 text-purple-800 dark:text-purple-200 font-extrabold">MULTI</span>}
                          {item.isBlank && <span className="text-[8px] px-1 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold">BLANK</span>}
                          {item.needsReview && <span className="text-[8px] px-1 rounded bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 font-bold">REVIEW</span>}
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={`text-[9px] font-mono px-1 py-0.5 rounded font-bold ${
                            item.confidence >= 80 
                              ? 'text-emerald-700 bg-emerald-100 dark:bg-emerald-950/60'
                              : item.confidence < 60
                              ? 'text-rose-700 bg-rose-100 dark:bg-rose-950/60'
                              : 'text-amber-700 bg-amber-100 dark:bg-amber-950/60'
                          }`}>
                            {item.confidence}%
                          </span>
                          <span className="text-[10px] font-bold text-amber-700 dark:text-amber-400 bg-amber-100/70 dark:bg-amber-950/50 px-1.5 py-0.5 rounded border border-amber-300 dark:border-amber-700">
                            Key: {item.correct.join(',')}
                          </span>
                        </div>
                      </div>

                      {/* Bubble selector override */}
                      <div className="flex items-center gap-1">
                        {optionLetters.map(opt => {
                          const isStudentMarked = item.marked.includes(opt);
                          const isCorrectKey = item.correct.includes(opt);

                          let btnStyle = 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300';
                          if (isStudentMarked && isCorrectKey) {
                            btnStyle = 'bg-emerald-600 text-white border-emerald-600 font-black ring-1 ring-emerald-300';
                          } else if (isStudentMarked && !isCorrectKey) {
                            btnStyle = 'bg-rose-600 text-white border-rose-600 font-black line-through';
                          } else if (!isStudentMarked && isCorrectKey) {
                            btnStyle = 'bg-amber-100 dark:bg-amber-950/60 text-amber-900 dark:text-amber-200 border-2 border-dashed border-amber-500 font-black ring-1 ring-amber-400';
                          }

                          return (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => handleToggleOptionOverride(item.questionNumber, opt)}
                              title={`Option ${opt}${isCorrectKey ? ' (Correct Answer)' : ''}${isStudentMarked ? ' (Marked by Student)' : ''}`}
                              className={`flex-1 h-7 rounded text-[11px] border flex items-center justify-center transition-all ${btnStyle}`}
                            >
                              {opt}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer Confirm & Save */}
            <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsReviewOpen(false);
                  startCamera();
                }}
                leftIcon={<RefreshCw className="w-4 h-4" />}
              >
                Discard & Rescan
              </Button>
              <Button
                variant="success"
                size="md"
                isLoading={savingResult}
                onClick={handleManualSave}
                leftIcon={<Save className="w-4 h-4" />}
              >
                Confirm & Record to Gradebook
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ========================================================================= */}
      {/* CAMERA DIAGNOSTIC & DEVICE SETTINGS PANEL MODAL                            */}
      {/* ========================================================================= */}
      <Modal
        isOpen={showDiagnosticsModal}
        onClose={() => setShowDiagnosticsModal(false)}
        title="Camera Hardware & Diagnostics Panel"
        description="Verify WebRTC permissions, inspect video resolution, switch camera hardware, or troubleshoot errors."
        maxWidth="2xl"
      >
        <div className="space-y-4 text-xs">
          {/* Status Matrix */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
              <p className="text-[10px] text-slate-500 font-bold uppercase">Permission</p>
              <Badge 
                variant={activePermission === 'granted' ? 'success' : activePermission === 'denied' ? 'danger' : 'warning'} 
                size="sm"
              >
                {activePermission.toUpperCase()}
              </Badge>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
              <p className="text-[10px] text-slate-500 font-bold uppercase">Stream State</p>
              <Badge variant={cameraActive ? 'teal' : 'outline'} size="sm">
                {cameraActive ? 'STREAMING' : 'INACTIVE'}
              </Badge>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
              <p className="text-[10px] text-slate-500 font-bold uppercase">Resolution</p>
              <p className="font-mono font-bold text-slate-800 dark:text-slate-200">
                {streamDimensions.width ? `${streamDimensions.width}×${streamDimensions.height}` : 'N/A'}
              </p>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
              <p className="text-[10px] text-slate-500 font-bold uppercase">Secure Context</p>
              <Badge variant={cameraService.isSecureContext() ? 'success' : 'danger'} size="sm">
                {cameraService.isSecureContext() ? 'HTTPS / LOCAL' : 'INSECURE HTTP'}
              </Badge>
            </div>
          </div>

          {/* Active Device Info */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-700 dark:text-slate-300">Selected Camera:</span>
              <span className="font-mono text-[11px] text-slate-500 truncate max-w-[220px]">
                {activeDeviceLabel || selectedDeviceId || 'None Selected'}
              </span>
            </div>

            {devices.length > 0 && (
              <div className="space-y-1 pt-1">
                <label className="text-[11px] text-slate-500 font-semibold">Change Video Device:</label>
                <select
                  value={selectedDeviceId}
                  onChange={(e) => {
                    const devId = e.target.value;
                    setSelectedDeviceId(devId);
                    const match = devices.find(d => d.deviceId === devId);
                    if (match) setActiveDeviceLabel(match.label);
                    startCamera(devId);
                  }}
                  className="w-full px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-xs font-bold text-slate-800 dark:text-slate-200"
                >
                  {devices.map((d, idx) => (
                    <option key={d.deviceId || idx} value={d.deviceId}>
                      {d.label || `Camera ${idx + 1}`} ({d.facingMode || 'generic'})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Error Notice if any */}
          {cameraError && (
            <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-800 text-red-900 dark:text-red-200 space-y-1">
              <p className="font-bold flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                Active Camera Notice
              </p>
              <p className="text-[11px] leading-relaxed">{cameraError}</p>
            </div>
          )}

          {/* Quick Actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleToggleCameraFacing}
                leftIcon={<SwitchCamera className="w-4 h-4 text-brand-600" />}
              >
                Switch Lens ({activeFacingMode === 'environment' ? 'Rear' : 'Front'})
              </Button>
              {hasTorch && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={toggleTorch}
                  leftIcon={<Zap className="w-4 h-4 text-amber-500" />}
                >
                  Torch {torchEnabled ? 'ON' : 'OFF'}
                </Button>
              )}
            </div>

            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setShowDiagnosticsModal(false);
                startCamera();
              }}
              leftIcon={<Camera className="w-4 h-4" />}
            >
              Restart Camera Stream
            </Button>
          </div>
        </div>
      </Modal>

      {/* ========================================================================= */}
      {/* OMR CALIBRATION & ACCURACY BENCHMARK MODAL                                 */}
      {/* ========================================================================= */}
      <Modal
        isOpen={showCalibrationModal}
        onClose={() => setShowCalibrationModal(false)}
        title="OMR Calibration & Accuracy Verification Benchmark"
        description="Ground-truth empirical testing against clean, rotated (8°), shadowed, light pencil, and multi-mark sheets."
        maxWidth="4xl"
      >
        {calibrationMetrics && (
          <div className="space-y-4 text-xs">
            {/* Top Score Callout */}
            <div className={`p-4 rounded-2xl flex items-center justify-between ${
              calibrationMetrics.testsPassed
                ? 'bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 text-emerald-950 dark:text-emerald-100'
                : 'bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-950 dark:text-rose-100'
            }`}>
              <div className="flex items-center gap-3">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center font-black text-2xl text-white ${
                  calibrationMetrics.testsPassed ? 'bg-emerald-600' : 'bg-rose-600'
                }`}>
                  {calibrationMetrics.overallAccuracy}%
                </div>
                <div>
                  <h3 className="font-black text-base">
                    Overall Ground-Truth Accuracy: {calibrationMetrics.overallAccuracy}%
                  </h3>
                  <p className="text-[11px] opacity-80 mt-0.5">
                    Evaluated across {calibrationMetrics.totalItemsTested} synthesized items under multiple physical conditions.
                  </p>
                </div>
              </div>

              <Badge variant={calibrationMetrics.testsPassed ? 'success' : 'danger'} size="md">
                {calibrationMetrics.testsPassed ? 'PASSED (>= 95% Precision)' : 'ATTENTION REQUIRED'}
              </Badge>
            </div>

            {/* Metrics Breakdown Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <p className="text-[10px] text-slate-500 font-bold uppercase">Clean Sheet</p>
                <p className="text-base font-black text-emerald-600 dark:text-emerald-400 mt-0.5">
                  {calibrationMetrics.cleanSheetAccuracy}%
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <p className="text-[10px] text-slate-500 font-bold uppercase">Rotated (8° Skew)</p>
                <p className="text-base font-black text-teal-600 dark:text-teal-400 mt-0.5">
                  {calibrationMetrics.rotatedSheetAccuracy}%
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <p className="text-[10px] text-slate-500 font-bold uppercase">Shadow Gradient</p>
                <p className="text-base font-black text-brand-600 dark:text-brand-400 mt-0.5">
                  {calibrationMetrics.shadowedSheetAccuracy}%
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <p className="text-[10px] text-slate-500 font-bold uppercase">Avg Processing Speed</p>
                <p className="text-base font-black text-slate-800 dark:text-slate-200 mt-0.5 font-mono">
                  {calibrationMetrics.avgProcessingTimeMs} ms
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <p className="text-[10px] text-slate-500 font-bold uppercase">Blank Detection</p>
                <p className="text-base font-black text-emerald-600 dark:text-emerald-400 mt-0.5">
                  {calibrationMetrics.blankDetectionAccuracy}%
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <p className="text-[10px] text-slate-500 font-bold uppercase">Multi-Mark Detection</p>
                <p className="text-base font-black text-purple-600 dark:text-purple-400 mt-0.5">
                  {calibrationMetrics.multipleMarkAccuracy}%
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <p className="text-[10px] text-slate-500 font-bold uppercase">False Positive Rate</p>
                <p className="text-base font-black text-emerald-600 dark:text-emerald-400 mt-0.5 font-mono">
                  {calibrationMetrics.falsePositiveRate}%
                </p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <p className="text-[10px] text-slate-500 font-bold uppercase">False Negative Rate</p>
                <p className="text-base font-black text-emerald-600 dark:text-emerald-400 mt-0.5 font-mono">
                  {calibrationMetrics.falseNegativeRate}%
                </p>
              </div>
            </div>

            {/* Per-Item Test Breakdown */}
            <div className="space-y-1.5 pt-1">
              <h4 className="font-bold text-slate-700 dark:text-slate-300">Ground-Truth Item Breakdown (20 Items):</h4>
              <div className="max-h-56 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-100 dark:divide-slate-800">
                {calibrationMetrics.itemBreakdown.map((row) => (
                  <div key={row.questionNumber} className="p-2 flex items-center justify-between text-xs bg-white dark:bg-slate-950">
                    <div className="flex items-center gap-2">
                      <span className="font-bold w-7">Q{row.questionNumber}.</span>
                      <span className="font-mono text-[11px] text-slate-500 uppercase">[{row.condition}]</span>
                      <span className="text-slate-600 dark:text-slate-400">
                        Expected: <strong className="text-slate-900 dark:text-slate-100">{row.expected.join(',') || 'BLANK'}</strong> • 
                        Detected: <strong className="text-slate-900 dark:text-slate-100">{row.detected.join(',') || 'BLANK'}</strong>
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-slate-400">{row.confidence}%</span>
                      <Badge variant={row.status === 'pass' ? 'success' : 'danger'} size="sm">
                        {row.status.toUpperCase()}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-slate-800">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCalibrationModal(false)}
              >
                Close
              </Button>
              <Button
                variant="primary"
                size="sm"
                isLoading={isCalibrating}
                onClick={handleRunCalibration}
                leftIcon={<RefreshCw className="w-4 h-4" />}
              >
                Re-Run Calibration Benchmark
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
