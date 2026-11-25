// ==============================================================================
// GradeScan - Reliable Cross-Platform Browser Camera Service
// Resilient WebRTC MediaStream Lifecycle, Android/Desktop Compatibility & Diagnostics
// ==============================================================================

export type CameraPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
  facingMode?: 'user' | 'environment';
}

export interface CameraStreamInfo {
  stream: MediaStream;
  videoWidth: number;
  videoHeight: number;
  deviceId: string;
  deviceLabel: string;
  hasTorch: boolean;
  facingMode?: string;
  isPortrait: boolean;
}

export interface CameraDiagnosticInfo {
  permission: CameraPermissionState;
  selectedDeviceId: string;
  selectedDeviceLabel: string;
  availableDevices: CameraDeviceInfo[];
  resolution: { width: number; height: number };
  isActive: boolean;
  isStarting: boolean;
  hasTorch: boolean;
  torchActive: boolean;
  error: string | null;
  isSecureContext: boolean;
}

class CameraService {
  private activeStream: MediaStream | null = null;
  private currentDeviceId: string = '';
  private currentDeviceLabel: string = '';
  private isStarting: boolean = false;
  private isTorchOn: boolean = false;
  private permissionStatus: CameraPermissionState = 'prompt';

  /**
   * Checks whether the browser and environment support WebRTC MediaDevices.
   */
  public isSupported(): boolean {
    return typeof navigator !== 'undefined' && 
      !!navigator.mediaDevices && 
      typeof navigator.mediaDevices.getUserMedia === 'function';
  }

  /**
   * Checks whether the current window context is secure (HTTPS or localhost).
   * Browsers strictly disallow camera access over unencrypted HTTP (except on localhost).
   */
  public isSecureContext(): boolean {
    if (typeof window === 'undefined') return true;
    if (window.isSecureContext !== undefined) return window.isSecureContext;
    const hostname = window.location.hostname;
    return (
      window.location.protocol === 'https:' ||
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.localhost')
    );
  }

  /**
   * Queries the browser's camera permission status if Permissions API is supported.
   */
  public async checkPermission(): Promise<CameraPermissionState> {
    if (!this.isSupported()) {
      this.permissionStatus = 'unsupported';
      return 'unsupported';
    }

    if (!this.isSecureContext()) {
      this.permissionStatus = 'denied';
      return 'denied';
    }

    try {
      if (navigator.permissions && navigator.permissions.query) {
        const result = await navigator.permissions.query({ name: 'camera' as PermissionName });
        this.permissionStatus = result.state as CameraPermissionState;
        
        result.onchange = () => {
          this.permissionStatus = result.state as CameraPermissionState;
        };
        return this.permissionStatus;
      }
    } catch {
      // Permissions API for 'camera' may not be supported in some mobile browsers (e.g. iOS Safari)
    }

    return this.permissionStatus;
  }

  /**
   * Enumerates all video input devices (front/rear cameras, webcams).
   */
  public async getAvailableCameras(): Promise<CameraDeviceInfo[]> {
    if (!this.isSupported()) return [];

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === 'videoinput');

      return videoInputs.map((device, index) => {
        let label = device.label || `Camera ${index + 1}`;
        const lowerLabel = label.toLowerCase();
        let facingMode: 'user' | 'environment' | undefined = undefined;

        if (lowerLabel.includes('back') || lowerLabel.includes('rear') || lowerLabel.includes('environment')) {
          facingMode = 'environment';
          if (!device.label) label = `Rear Camera ${index + 1}`;
        } else if (lowerLabel.includes('front') || lowerLabel.includes('user') || lowerLabel.includes('selfie')) {
          facingMode = 'user';
          if (!device.label) label = `Front Camera ${index + 1}`;
        }

        return {
          deviceId: device.deviceId,
          label,
          facingMode,
        };
      });
    } catch (err) {
      console.warn('[CameraService] enumerateDevices error:', err);
      return [];
    }
  }

  /**
   * Selects the best default camera: prefers rear/back camera on mobile devices.
   */
  public selectDefaultCamera(cameras: CameraDeviceInfo[]): string {
    if (cameras.length === 0) return '';
    const rear = cameras.find(
      (c) => c.facingMode === 'environment' || c.label.toLowerCase().includes('back') || c.label.toLowerCase().includes('rear')
    );
    if (rear) return rear.deviceId;
    return cameras[0].deviceId;
  }

  /**
   * Formats camera exceptions into actionable, user-friendly diagnostic messages.
   */
  public formatErrorMessage(error: any): string {
    if (!this.isSecureContext()) {
      return 'Camera requires a secure context (HTTPS) or localhost. Please load the application using https://.';
    }

    if (!error) return 'Unknown camera error occurred.';

    const name = error.name || error.constructor?.name || '';
    const message = error.message || '';

    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        this.permissionStatus = 'denied';
        return 'Camera permission was denied. Please allow camera permissions in your browser address bar (lock/camera icon) and refresh.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No camera device found on this system. Please connect a webcam or use a mobile device with a camera.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Camera hardware is already in use by another application or tab (e.g., Zoom, Teams). Please close other camera apps and retry.';
      case 'OverconstrainedError':
        return `Requested camera constraints could not be satisfied (${error.constraint || 'resolution'}). Falling back to standard mode.`;
      case 'SecurityError':
        return 'Camera access is restricted due to security policies or an insecure HTTP origin.';
      case 'AbortError':
        return 'Camera startup was interrupted. Please try again.';
      default:
        return message || 'Unable to open camera. Please verify device permissions and try again.';
    }
  }

  /**
   * Starts camera stream with progressive constraint fallbacks.
   * Prevents multiple concurrent getUserMedia calls.
   */
  public async startCamera(
    videoElement: HTMLVideoElement,
    options: {
      deviceId?: string;
      preferFacingMode?: 'user' | 'environment';
      idealWidth?: number;
      idealHeight?: number;
    } = {}
  ): Promise<CameraStreamInfo> {
    if (!this.isSupported()) {
      throw new Error('Camera API (navigator.mediaDevices.getUserMedia) is not supported in this browser.');
    }

    if (!this.isSecureContext()) {
      throw new Error('Camera access requires HTTPS or localhost. Please access via https://.');
    }

    if (this.isStarting) {
      console.warn('[CameraService] startCamera called while already starting. Waiting...');
      // Wait briefly if already starting
      await new Promise((r) => setTimeout(r, 200));
    }

    this.isStarting = true;

    try {
      // 1. Stop any currently active camera stream before creating a new one
      this.stopCamera(videoElement);

      const preferFacing = options.preferFacingMode || 'environment';
      const idealW = options.idealWidth || 1920;
      const idealH = options.idealHeight || 1080;

      let stream: MediaStream | null = null;
      let lastError: any = null;

      // Tier 1: Specific Device ID (if provided)
      if (options.deviceId) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: options.deviceId },
              width: { ideal: idealW },
              height: { ideal: idealH },
            },
            audio: false,
          });
        } catch (err) {
          console.warn('[CameraService] Tier 1 exact deviceId failed, falling back:', err);
          lastError = err;
        }
      }

      // Tier 2: Preferred facing mode with high resolution
      if (!stream) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: preferFacing },
              width: { ideal: idealW },
              height: { ideal: idealH },
            },
            audio: false,
          });
        } catch (err) {
          console.warn('[CameraService] Tier 2 ideal facingMode failed, falling back:', err);
          lastError = err;
        }
      }

      // Tier 3: Loose facing mode without resolution constraints
      if (!stream) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: preferFacing },
            audio: false,
          });
        } catch (err) {
          console.warn('[CameraService] Tier 3 loose facingMode failed, falling back:', err);
          lastError = err;
        }
      }

      // Tier 4: Most permissive basic fallback { video: true }
      if (!stream) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          });
        } catch (err) {
          lastError = err;
          throw err;
        }
      }

      if (!stream) {
        throw lastError || new Error('Failed to acquire camera stream.');
      }

      this.activeStream = stream;
      this.permissionStatus = 'granted';

      // 2. Attach stream to video element
      videoElement.srcObject = stream;
      videoElement.setAttribute('playsinline', 'true');
      videoElement.setAttribute('webkit-playsinline', 'true');
      videoElement.muted = true;

      // 3. Wait for video metadata to be loaded so dimensions are known
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          // If metadata takes too long, resolve anyway if video is playing
          if (videoElement.videoWidth > 0) resolve();
          else reject(new Error('Camera preview metadata timed out.'));
        }, 5000);

        const onMetadata = () => {
          clearTimeout(timeout);
          videoElement.removeEventListener('loadedmetadata', onMetadata);
          resolve();
        };

        if (videoElement.readyState >= 1 && videoElement.videoWidth > 0) {
          clearTimeout(timeout);
          resolve();
        } else {
          videoElement.addEventListener('loadedmetadata', onMetadata);
        }
      });

      // 4. Safely trigger video playback (handling mobile autoplay policy)
      try {
        await videoElement.play();
      } catch (playErr) {
        console.warn('[CameraService] videoElement.play() warning:', playErr);
      }

      // 5. Inspect track capabilities
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings?.() || {};
      const caps = (track as any)?.getCapabilities?.() || {};
      const hasTorch = Boolean(caps && 'torch' in caps);

      this.currentDeviceId = settings.deviceId || options.deviceId || '';
      this.currentDeviceLabel = track.label || 'Active Camera';
      this.isTorchOn = false;

      const videoWidth = videoElement.videoWidth || (settings.width as number) || 1280;
      const videoHeight = videoElement.videoHeight || (settings.height as number) || 720;
      const isPortrait = videoHeight > videoWidth;

      return {
        stream,
        videoWidth,
        videoHeight,
        deviceId: this.currentDeviceId,
        deviceLabel: this.currentDeviceLabel,
        hasTorch,
        facingMode: settings.facingMode,
        isPortrait,
      };
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Halts all active media stream tracks and detaches video element.
   */
  public stopCamera(videoElement?: HTMLVideoElement | null): void {
    if (this.activeStream) {
      try {
        this.activeStream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (e) {
            console.warn('[CameraService] error stopping track:', e);
          }
        });
      } catch (e) {
        console.warn('[CameraService] error stopping activeStream:', e);
      }
      this.activeStream = null;
    }

    if (videoElement) {
      try {
        videoElement.srcObject = null;
      } catch {
        // ignore
      }
    }

    this.isTorchOn = false;
  }

  /**
   * Toggles the hardware flashlight/torch if supported by the camera device.
   */
  public async setTorch(enabled: boolean): Promise<boolean> {
    if (!this.activeStream) return false;
    const track = this.activeStream.getVideoTracks()[0];
    if (!track) return false;

    try {
      const caps = (track as any).getCapabilities?.();
      if (caps && 'torch' in caps) {
        await (track as any).applyConstraints({
          advanced: [{ torch: enabled }],
        });
        this.isTorchOn = enabled;
        return true;
      }
    } catch (err) {
      console.warn('[CameraService] torch toggle error:', err);
    }
    return false;
  }

  /**
   * Captures the current video frame to an in-memory high-resolution Canvas.
   */
  public captureFrame(videoElement: HTMLVideoElement): { canvas: HTMLCanvasElement; dataUrl: string } | null {
    if (!videoElement || videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

    return { canvas, dataUrl };
  }

  /**
   * Retrieves current stream and camera diagnostic state.
   */
  public getDiagnosticInfo(videoElement?: HTMLVideoElement | null): Partial<CameraDiagnosticInfo> {
    const isStreaming = Boolean(
      this.activeStream && 
      this.activeStream.active && 
      this.activeStream.getVideoTracks().some(t => t.readyState === 'live')
    );

    return {
      permission: this.permissionStatus,
      selectedDeviceId: this.currentDeviceId,
      selectedDeviceLabel: this.currentDeviceLabel,
      resolution: {
        width: videoElement?.videoWidth || 0,
        height: videoElement?.videoHeight || 0,
      },
      isActive: isStreaming,
      isStarting: this.isStarting,
      torchActive: this.isTorchOn,
      isSecureContext: this.isSecureContext(),
    };
  }
}

export const cameraService = new CameraService();
