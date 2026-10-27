import type React from "react";
import { Composition } from "remotion";
import storyboard from "../storyboard.json";
import { durationInFrames, Film } from "./Film";

export const Root: React.FC = () => (
  <Composition
    id="Film"
    component={Film}
    durationInFrames={durationInFrames(storyboard.fps)}
    fps={storyboard.fps}
    width={storyboard.width}
    height={storyboard.height}
  />
);
