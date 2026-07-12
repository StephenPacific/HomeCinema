import assert from "node:assert/strict";
import test from "node:test";
import { configurePlaybackAudioSession, readAudioSession } from "../src/audioSession.js";

test("unsupported browsers keep their default audio routing", () => {
  assert.deepEqual(readAudioSession(null), {
    supported: false,
    configured: false,
    type: "unavailable",
    state: "unavailable"
  });
  assert.deepEqual(configurePlaybackAudioSession(null), readAudioSession(null));
});

test("speaker pages request long-form playback routing", () => {
  const audioSession = { type: "auto", state: "inactive" };

  assert.deepEqual(configurePlaybackAudioSession(audioSession), {
    supported: true,
    configured: true,
    type: "playback",
    state: "inactive"
  });
});

test("a browser that rejects playback routing remains usable", () => {
  const audioSession = {
    state: "inactive",
    get type() {
      return "auto";
    },
    set type(_value) {
      throw new Error("unsupported audio session type");
    }
  };

  assert.deepEqual(configurePlaybackAudioSession(audioSession), {
    supported: true,
    configured: false,
    type: "auto",
    state: "inactive"
  });
});
