# Local OCR third-party notices

The browser OCR runtime is self-hosted so planning images are not sent to an external OCR service.

- Tesseract.js browser/worker runtime: 7.0.0, Apache-2.0. See `LICENSE.md` and the generated `.LICENSE.txt` files.
- Tesseract.js Core LSTM variants: Apache-2.0. See `../tesseract-core/LICENSE`.
- Norwegian and English traineddata: Tesseract language data, Apache-2.0 compatible distribution. These files are runtime data only and are never modified or trained in the browser.

Pinned SHA-256 checksums:

```text
000c27d9cd0def655f77b36c72a389c0ab13793aa31cb4d7aab56d09c0afbc7e  tesseract.min.js
576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d  worker.min.js
eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680  ../tesseract-core/tesseract-core-lstm.wasm.js
861a536cf9ef8e63cb644d57bab39c388f37f7d6b6f60024b741c5f6b39a59b3  ../tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js
c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38  ../tesseract-core/tesseract-core-simd-lstm.wasm.js
5dc01cdc0421ecfe29fad5f35bd6125d08563f3e36016c3b446117f43725b610  ../tessdata/nor.traineddata.gz
18c1ac52b75e35d44735fb6c2a60acfaf23033524653200738e98f0243edb75b  ../tessdata/eng.traineddata.gz
```
