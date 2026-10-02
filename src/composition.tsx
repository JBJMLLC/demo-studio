import React from 'react';
import { AbsoluteFill, Audio, Composition, Sequence, Video, registerRoot, useCurrentFrame } from 'remotion';

export type VideoProps = {
  recordingUrl: string;
  width: number;
  height: number;
  durationInFrames: number;
  captions: Array<{ startFrame: number; endFrame: number; text: string }>;
  audio: Array<{ url: string; startFrame: number; frames: number }>;
  captionBandHeight: number;
};

const DemoVideo: React.FC<VideoProps> = (props) => {
  const frame = useCurrentFrame();
  const caption = props.captions.find((entry) => frame >= entry.startFrame && frame < entry.endFrame);
  return <AbsoluteFill style={{ backgroundColor: '#f5f7fb' }}>
    <Video src={props.recordingUrl} muted playbackRate={1} style={{ width: '100%', height: `calc(100% - ${props.captionBandHeight}px)`, objectFit: 'contain' }} />
    {props.audio.map((track) => <Sequence key={track.url} from={track.startFrame} durationInFrames={track.frames}>
      <Audio src={track.url} playbackRate={1} />
    </Sequence>)}
    {props.captionBandHeight > 0 && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: props.captionBandHeight, display: 'grid', placeItems: 'center', textAlign: 'center', pointerEvents: 'none', color: 'white', background: '#141a29', padding: '0 24px', boxSizing: 'border-box' }}>
      <span style={{ font: '500 20px/1.35 Arial, sans-serif', maxWidth: '100%' }}>{caption?.text || ''}</span>
    </div>}
  </AbsoluteFill>;
};

const defaults: VideoProps = { recordingUrl: '', width: 1280, height: 800, durationInFrames: 30, captions: [], audio: [], captionBandHeight: 0 };
const Root = () => <Composition id="Demo" component={DemoVideo} defaultProps={defaults} durationInFrames={30} fps={30} width={1280} height={800}
  calculateMetadata={({ props }: { props: VideoProps }) => ({ durationInFrames: props.durationInFrames, width: props.width, height: props.height })} />;

registerRoot(Root);
