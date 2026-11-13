import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync(new URL("../src/services/session.ts", import.meta.url), "utf8");
const viewer = readFileSync(new URL("../src/components/SessionViewer.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

assert.match(
  service,
  /session\.answer_question\.accepted[\s\S]*?resolveAnswerQuestionRequest\([^)]*,\s*true\)/,
  "answer submissions must wait for the server acknowledgement",
);
assert.match(
  service,
  /answerQuestionRequests[\s\S]*?resolve\(false\)/,
  "rejected or timed-out answers must resolve as not accepted",
);
assert.match(
  viewer,
  /accepted === false[\s\S]*?askSubmitFailed/,
  "a rejected answer must keep the question open and report the failure",
);
assert.match(
  viewer,
  /submittedAskUserAnswers[\s\S]*?answerStateKey[\s\S]*?setSubmitted\(true\)/,
  "submitted answers must survive card remounts",
);
assert.match(
  app,
  /return sessionService\.answerQuestion\(/,
  "the viewer must receive the answer submission result",
);
assert.match(
  app,
  /typeof payload\.session\.pending === "boolean"[\s\S]*?markSessionPending\(rootID, sessionKey\)[\s\S]*?handleSessionStreamDone\(rootID, sessionKey\)/,
  "session metadata must keep subagent reply indicators in sync",
);

console.log("ask user submit passed");
