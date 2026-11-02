import type { Board } from "./storyboard";

// One cue per scene, timed from the scene durations in order. Scenes without a
// subtitle keep their time but get no cue.
export function subtitleCues(board: Pick<Board, "scenes">) {
  let start = 0;
  return board.scenes.flatMap(scene => {
    const cue = { start, end: start + scene.duration, text: scene.subtitle.replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean).join("\n") };
    start = cue.end;
    return cue.text ? [cue] : [];
  });
}

const timestamp = (seconds: number, separator: "," | ".") => {
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}${separator}000`;
};

// SRT starts with a BOM so Windows editors read non-Latin text as UTF-8.
export function srt(board: Pick<Board, "scenes">) {
  return "﻿" + subtitleCues(board).map((cue, i) => `${i + 1}\r\n${timestamp(cue.start, ",")} --> ${timestamp(cue.end, ",")}\r\n${cue.text.replace(/\n/g, "\r\n")}\r\n`).join("\r\n");
}

export function vtt(board: Pick<Board, "scenes">) {
  // A line of only "-->" would end the cue early; WebVTT has no escape for it.
  return "WEBVTT\n\n" + subtitleCues(board).map(cue => `${timestamp(cue.start, ".")} --> ${timestamp(cue.end, ".")}\n${cue.text.replace(/-->/g, "→")}\n`).join("\n");
}
