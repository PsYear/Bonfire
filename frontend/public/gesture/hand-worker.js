/* MediaPipe's WASM loader uses importScripts, so this must be a classic worker. */
var exports = {};
importScripts("./vision_bundle.js");

(() => {
  let detector = null;
  let detailed = false;
  self.onmessage = async ({ data }) => {
    if (data.type === "init") {
      detailed = data.includeWorld === true;
      try {
        const fileset = await exports.FilesetResolver.forVisionTasks(data.assetRoot + "wasm");
        detector = await exports.HandLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: data.assetRoot + "hand_landmarker.task",
            delegate: "CPU",
          },
          canvas: new OffscreenCanvas(320, 240),
          runningMode: "VIDEO",
          numHands: 1,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
        self.postMessage({ type: "ready" });
      } catch (error) {
        self.postMessage({ type: "error", message: String(error) });
      }
      return;
    }
    if (data.type !== "frame") return;
    try {
      const result = detector.detectForVideo(data.bitmap, data.time);
      const landmarks = result.landmarks[0] ?? [];
      self.postMessage({
        type: "result",
        time: data.time,
        epoch: data.epoch,
        landmarks,
        hand: result.handedness[0]?.[0]?.categoryName ?? "",
        ...(detailed ? {
          confidence: result.handedness[0]?.[0]?.score ?? 0,
          worldLandmarks: result.worldLandmarks[0] ?? [],
        } : {}),
      });
    } catch (error) {
      self.postMessage({ type: "error", message: String(error) });
    } finally {
      data.bitmap.close();
    }
  };
})();
