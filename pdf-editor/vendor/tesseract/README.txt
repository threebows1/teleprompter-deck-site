tesseract.js 7.0.0 (tesseract.min.js, worker.min.js) and tesseract.js-core 7.0.0
(core/: the LSTM-only engine builds, plain / SIMD / relaxed SIMD; the worker picks
one). Both Apache-2.0: LICENSE (tesseract.js) and core/LICENSE (tesseract.js-core).
Language models are not bundled; they download from
cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0_best_int the first time.
