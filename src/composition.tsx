import React from 'react';
import { AbsoluteFill, Audio, Composition, Sequence, OffthreadVideo, registerRoot, useCurrentFrame, useVideoConfig } from 'remotion';
import { zoomAt, type ZoomWindow } from './zoom.js';

export type VideoProps = {
  recordingUrl: string;
  width: number;
  height: number;
  durationInFrames: number;
  captions: Array<{ startFrame: number; endFrame: number; text: string }>;
  audio: Array<{ url: string; startFrame: number; frames: number }>;
  captionBandHeight: number;
  zoom?: { scale: number; windows: ZoomWindow[] };
};

const DemoVideo: React.FC<VideoProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const caption = props.captions.find((entry) => frame >= entry.startFrame && frame < entry.endFrame);
  // The recording is shrunk to sit above the caption band and centered; the sides are letterboxed.
  const fit = (props.height - props.captionBandHeight) / props.height;
  const view = zoomAt(frame, props.zoom?.windows ?? [], props.zoom?.scale ?? 1, props.width, props.height, fps);
  return <AbsoluteFill style={{ backgroundColor: '#000' }}>
    <div style={{ position: 'absolute', top: 0, left: (props.width - props.width * fit) / 2, width: props.width * fit, height: props.height * fit, overflow: 'hidden' }}>
      <div style={{ width: '100%', height: '100%', transformOrigin: '0 0', transform: `scale(${view.scale}) translate(${-view.left * fit}px, ${-view.top * fit}px)` }}>
        <OffthreadVideo src={props.recordingUrl} muted playbackRate={1} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
    {props.audio.map((track) => <Sequence key={track.url} from={track.startFrame} durationInFrames={track.frames}>
      <Audio src={track.url} playbackRate={1} />
    </Sequence>)}
    {props.captionBandHeight > 0 && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: props.captionBandHeight, display: 'grid', placeItems: 'center', textAlign: 'center', pointerEvents: 'none', color: 'white', background: '#000', padding: '0 24px', boxSizing: 'border-box' }}>
      <span style={{ font: '500 20px/1.35 Arial, sans-serif', maxWidth: '100%' }}>{caption?.text || ''}</span>
    </div>}
  </AbsoluteFill>;
};

const defaults: VideoProps = { recordingUrl: '', width: 1280, height: 800, durationInFrames: 30, captions: [], audio: [], captionBandHeight: 0 };
const Root = () => <Composition id="Demo" component={DemoVideo} defaultProps={defaults} durationInFrames={30} fps={30} width={1280} height={800}
  calculateMetadata={({ props }: { props: VideoProps }) => ({ durationInFrames: props.durationInFrames, width: props.width, height: props.height })} />;

registerRoot(Root);
