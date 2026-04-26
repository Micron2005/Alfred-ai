# Wake-word model attributions

## hey_alfred_v0.1.onnx

Community-trained "Hey Alfred" wake-word model. Originally distributed
as a TFLite for use with [Wyoming Satellite][wyoming] by
[The-Blackstone/HeyAlfredWakeWord][heyalfred] (sensitivity-3 build).
Converted to ONNX with `tf2onnx` so it can run through
`onnxruntime-web` in the browser. Same `[1, 16, 96]` embedding-window
architecture as the official openWakeWord models, so it drops in
without any pipeline changes.

[wyoming]: https://github.com/rhasspy/wyoming-satellite
[heyalfred]: https://github.com/The-Blackstone/HeyAlfredWakeWord

## hey_jarvis_v0.1.onnx, alexa_v0.1.onnx, hey_mycroft_v0.1.onnx, hey_rhasspy_v0.1.onnx, timer_v0.1.onnx, weather_v0.1.onnx, melspectrogram.onnx, embedding_model.onnx

Official openWakeWord pre-trained models, distributed under
**CC BY-NC-SA 4.0** by [@dscripka][dscripka]. Bundled by the
[`openwakeword-wasm-browser`][oww-browser] npm package and copied here
for static serving. See https://huggingface.co/davidscripka/openwakeword
for the upstream weights.

[dscripka]: https://github.com/dscripka/openWakeWord
[oww-browser]: https://www.npmjs.com/package/openwakeword-wasm-browser

## silero_vad.onnx

[Silero VAD][silero], MIT-licensed. Used for voice-activity gating so
the wake-word classifier only spends compute when someone is actually
speaking.

[silero]: https://github.com/snakers4/silero-vad
