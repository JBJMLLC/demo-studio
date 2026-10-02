import React from 'react';
import { AbsoluteFill, Audio, Composition, Sequence, Video, registerRoot, useCurrentFrame } from 'remotion';

export type VideoProps = {
  recordingUrl: string;
  width: number;
  height: number;
  durationInFrames: number;
  captions: Array<{ startFrame: number; endFrame: number; text: string }>;
  audio: Array<{ url: string; startFrame: number; frames: number }>;
};

const DemoVideo: React.FC<VideoProps> = (props) => {
  const frame = useCurrentFrame();
  const caption = props.captions.find((entry) => frame >= entry.startFrame && frame < entry.endFrame);
  return <AbsoluteFill style={{ backgroundColor: '#f5f7fb' }}>
    <Video src={props.recordingUrl} muted playbackRate={1} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
    {props.audio.map((track) => <Sequence key={track.url} from={track.startFrame} durationInFrames={track.frames}>
      <Audio src={track.url} playbackRate={1} />
    </Sequence>)}
    {caption && <div style={{ position: 'absolute', bottom: 18, left: '12%', right: '12%', textAlign: 'center', pointerEvents: 'none' }}>
      <span style={{ display: 'inline-block', color: 'white', background: '#141a29ed', borderRadius: 8, padding: '9px 16px', font: '500 20px/1.35 Arial, sans-serif', maxWidth: '100%' }}>{caption.text}</span>
    </div>}
  </AbsoluteFill>;
};

const defaults: VideoProps = { recordingUrl: '', width: 1280, height: 800, durationInFrames: 30, captions: [], audio: [] };
const Root = () => <Composition id="Demo" component={DemoVideo} defaultProps={defaults} durationInFrames={30} fps={30} width={1280} height={800}
  calculateMetadata={({ props }: { props: VideoProps }) => ({ durationInFrames: props.durationInFrames, width: props.width, height: props.height })} />;

registerRoot(Root);
