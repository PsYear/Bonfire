# Hand tracking assets

Hand detection and landmarks run locally in a dedicated Web Worker. No camera
frames are uploaded and no microphone is requested.

- Runtime: [`@mediapipe/tasks-vision` 0.10.32](https://www.npmjs.com/package/@mediapipe/tasks-vision),
  MediaPipe Authors, Apache License 2.0. `scripts/prepare-gesture.mjs` copies the
  pinned runtime and SIMD/non-SIMD WASM files from npm into this directory.
- Model: MediaPipe Hand Landmarker, float16, version 1.
  [Official model source](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task).
  [Model documentation](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker).
  Distributed as part of the MediaPipe project under Apache License 2.0.
- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)

The model is checked into `hand_landmarker.task`. Generated runtime files are
ignored by Git and recreated during install, development startup and build.
Assets load only when the user enables hand control.
