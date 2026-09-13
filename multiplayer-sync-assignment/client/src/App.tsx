import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Users,
  Radio,
  Zap,
  Activity,
  Sliders,
  RefreshCw,
  Layers,
  Flame,
  Heart,
  PartyPopper,
  Rocket,
  ThumbsUp,
  Wifi,
  WifiOff,
  ChevronRight,
  ChevronDown,
  Sparkles,
  RotateCcw,
} from 'lucide-react';
import { createRoom, RoomHandle, ClientMetrics } from './connection';
import { InterpolationManager, InterpolationMode } from './interpolation';
import { CanvasRenderer } from './render';
import { RemotePeerState } from './protocol';

const REACTION_EMOJIS = [
  { emoji: '🔥', label: 'Fire', icon: Flame },
  { emoji: '❤️', label: 'Love', icon: Heart },
  { emoji: '🎉', label: 'Party', icon: PartyPopper },
  { emoji: '⚡', label: 'Hype', icon: Zap },
  { emoji: '🚀', label: 'Rocket', icon: Rocket },
  { emoji: '👏', label: 'Clap', icon: ThumbsUp },
];

const PRESET_COLORS = [
  '#f43f5e',
  '#ec4899',
  '#8b5cf6',
  '#3b82f6',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#f97316',
];

function getOrCreateClientId(): string {
  let id = sessionStorage.getItem('fan_sync_client_id');
  if (!id) {
    id = 'user_' + Math.random().toString(36).substring(2, 9);
    sessionStorage.setItem('fan_sync_client_id', id);
  }
  return id;
}

export default function App() {
  const [clientId] = useState(getOrCreateClientId);
  const [name, setName] = useState(() => 'Fan-' + clientId.slice(-4).toUpperCase());
  const [color, setColor] = useState(() => {
    const idx = Math.floor(Math.random() * PRESET_COLORS.length);
    return PRESET_COLORS[idx];
  });
  const [roomId, setRoomId] = useState('watch-party-42');

  // Interactive state
  const [hypeTotal, setHypeTotal] = useState(128);
  const [selectedEmoji, setSelectedEmoji] = useState('🔥');
  const [activePeers, setActivePeers] = useState<RemotePeerState[]>([]);
  const [metrics, setMetrics] = useState<ClientMetrics>({
    rttMs: 0,
    jitterMs: 0,
    packetsSent: 0,
    packetsReceived: 0,
    remoteUpdatesPerSec: 0,
    connected: false,
  });

  // Diagnostics & Simulation
  const [interpMode, setInterpMode] = useState<InterpolationMode>('extrapolation');
  const [bufferDelay, setBufferDelay] = useState<number>(50);
  const [simLatency, setSimLatency] = useState<number>(0);
  const [simJitter, setSimJitter] = useState<number>(0);
  const [simLoss, setSimLoss] = useState<number>(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [presenceOpen, setPresenceOpen] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const interpManagerRef = useRef<InterpolationManager>(new InterpolationManager());
  const roomRef = useRef<RoomHandle | null>(null);
  const localCursorPosRef = useRef<{ x: number; y: number } | null>(null);

  // Sync settings into interpolation manager
  useEffect(() => {
    interpManagerRef.current.mode = interpMode;
    interpManagerRef.current.bufferDelayMs = bufferDelay;
  }, [interpMode, bufferDelay]);

  // Sync simulated network options
  useEffect(() => {
    if (roomRef.current) {
      roomRef.current.setSimulatedNetwork({
        latencyMs: simLatency,
        jitterMs: simJitter,
        packetLossRate: simLoss / 100,
      });
    }
  }, [simLatency, simJitter, simLoss]);

  // Connect to room
  useEffect(() => {
    const interp = interpManagerRef.current;
    interp.clear();

    const room = createRoom({
      roomId,
      clientId,
      name,
      color,
      throttleIntervalMs: 30,
    });
    roomRef.current = room;

    room.setSimulatedNetwork({
      latencyMs: simLatency,
      jitterMs: simJitter,
      packetLossRate: simLoss / 100,
    });

    const unsubAction = room.onRemoteAction((remoteId, action) => {
      if (action.type === 'cursor') {
        interp.pushPeerCursor(remoteId, action.x, action.y, action.seq ?? 0);
      } else if (action.type === 'reaction') {
        const peer = interp.getPeer(remoteId);
        rendererRef.current?.addReactionBurst(
          action.emoji,
          action.x,
          action.y,
          peer?.color || '#818cf8'
        );
      }
    });

    const unsubSnapshot = room.onStateSnapshot((clients, initialHype) => {
      setActivePeers(clients);
      setHypeTotal(initialHype);
      for (const client of clients) {
        const p = interp.getOrCreatePeer(
          client.clientId,
          client.name,
          client.color,
          client.cursor?.x ?? 0.5,
          client.cursor?.y ?? 0.5
        );
        if (client.cursor) {
          p.pushSample(client.cursor.x, client.cursor.y, client.cursor.seq);
        }
      }
    });

    const unsubJoin = room.onPeerJoin((client) => {
      setActivePeers((prev) => {
        if (prev.some((p) => p.clientId === client.clientId)) return prev;
        return [...prev, client];
      });
      interp.getOrCreatePeer(client.clientId, client.name, client.color);
    });

    const unsubLeave = room.onPeerLeave((leftClientId) => {
      setActivePeers((prev) => prev.filter((p) => p.clientId !== leftClientId));
      interp.removePeer(leftClientId);
    });

    const unsubHype = room.onHypeUpdate((totalCount) => {
      setHypeTotal(totalCount);
      rendererRef.current?.addReactionBurst('⚡', 0.5, 0.45, '#eab308');
    });

    const unsubMetrics = room.onMetrics((m) => {
      setMetrics(m);
    });

    return () => {
      unsubAction();
      unsubSnapshot();
      unsubJoin();
      unsubLeave();
      unsubHype();
      unsubMetrics();
      room.destroy();
    };
  }, [roomId, clientId, name, color]);

  // Set up 60 FPS Canvas rendering loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new CanvasRenderer(canvas);
    rendererRef.current = renderer;

    const handleResize = () => renderer.resize();
    window.addEventListener('resize', handleResize);

    let animationFrameId: number;

    const loop = () => {
      const now = performance.now();
      const smoothedCursors = interpManagerRef.current.updateAll(now);

      renderer.render(
        smoothedCursors,
        localCursorPosRef.current,
        name,
        color
      );

      animationFrameId = requestAnimationFrame(loop);
    };

    animationFrameId = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [name, color]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const normX = e.clientX / window.innerWidth;
    const normY = e.clientY / window.innerHeight;

    localCursorPosRef.current = { x: normX, y: normY };

    if (roomRef.current) {
      roomRef.current.sendAction({
        type: 'cursor',
        x: normX,
        y: normY,
      });
    }
  }, []);

  const emitReaction = useCallback(
    (emoji: string, customX?: number, customY?: number) => {
      const x = customX ?? (localCursorPosRef.current ? localCursorPosRef.current.x : 0.5);
      const y = customY ?? (localCursorPosRef.current ? localCursorPosRef.current.y : 0.5);

      rendererRef.current?.addReactionBurst(emoji, x, y, color);

      roomRef.current?.sendAction({
        type: 'reaction',
        emoji,
        x,
        y,
      });
    },
    [color]
  );

  const handleHypeTap = useCallback(() => {
    rendererRef.current?.addReactionBurst('⚡', 0.5, 0.45, '#fbbf24');
    roomRef.current?.sendAction({
      type: 'hype_tap',
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = parseInt(e.key, 10);
      if (key >= 1 && key <= REACTION_EMOJIS.length) {
        const item = REACTION_EMOJIS[key - 1];
        setSelectedEmoji(item.emoji);
        emitReaction(item.emoji);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [emitReaction]);

  return (
    <div
      className="app-container"
      onPointerMove={handlePointerMove}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('app-container') || target.tagName === 'CANVAS') {
          emitReaction(selectedEmoji, e.clientX / window.innerWidth, e.clientY / window.innerHeight);
        }
      }}
    >
      <div className="ambient-grid" />
      <div className="ambient-glow" />

      {/* 60 FPS Canvas Layer */}
      <canvas ref={canvasRef} className="canvas-overlay" />

      {/* Top Header Bar */}
      <header className="top-header">
        <div className="header-left">
          <div className="glass-pill">
            <div className="live-badge">
              <span className="pulse-dot" />
              LIVE FAN MOMENT
            </div>
            <div className="room-tag">
              <span>Room:</span>
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.trim() || 'watch-party-42')}
                className="room-input"
                title="Change room ID"
              />
            </div>
          </div>
        </div>

        <div className="header-right">
          <button
            onClick={() => setPresenceOpen(!presenceOpen)}
            className="viewer-btn"
            title="View participants"
          >
            <Users size={14} color="#818cf8" />
            <span>{activePeers.length + 1} Viewers</span>
          </button>

          <div className="glass-pill">
            <div className="user-tag">
              <div className="color-dot" style={{ backgroundColor: color }} />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 16))}
                className="username-input"
                title="Click to change your name"
              />
            </div>
            <div className="ping-stat">
              {metrics.connected ? (
                <>
                  <Wifi size={12} />
                  <span>{metrics.rttMs}ms</span>
                </>
              ) : (
                <>
                  <WifiOff size={12} color="#f43f5e" />
                  <span style={{ color: '#f43f5e' }}>Connecting</span>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Center Broadcast Card */}
      <main className="stage-center">
        <div className="broadcast-card">
          <div className="card-tag">
            <Sparkles size={14} />
            <span>Championship World Finals</span>
          </div>
          <h1 className="card-title">Live Interactive Arena</h1>
          <p className="card-subtitle">
            Interact with the broadcast and other viewers in real time.
          </p>

          <button onClick={handleHypeTap} className="hype-button">
            <Zap size={18} fill="#0f172a" />
            <span>TAP FAN HYPE</span>
            <span className="hype-counter-badge">{hypeTotal.toLocaleString()}</span>
          </button>
          <div className="card-caption">
            Global live count
          </div>
        </div>

        <div className="hint-pill">
          💡 Open this URL in multiple tabs to test live sync.
        </div>
      </main>

      {/* Bottom Floating Reaction Dock */}
      <footer className="bottom-dock">
        <span className="dock-label">Reactions</span>
        <div className="reaction-btn-group">
          {REACTION_EMOJIS.map((item, idx) => (
            <button
              key={item.emoji}
              onClick={() => {
                setSelectedEmoji(item.emoji);
                emitReaction(item.emoji);
              }}
              className={`reaction-btn ${selectedEmoji === item.emoji ? 'selected' : ''}`}
              title={`Press '${idx + 1}' or tap to burst`}
            >
              <span>{item.emoji}</span>
              <span className="key-hint">{idx + 1}</span>
            </button>
          ))}
        </div>
      </footer>

      {/* Floating Diagnostics / Inspector Drawer */}
      <aside className={`diagnostics-panel ${panelOpen ? '' : 'collapsed'}`}>
        <div className="panel-header">
          <div className="panel-title">
            <Sliders size={14} color="#818cf8" />
            {panelOpen && <span>Sync Engine Controls</span>}
          </div>
          <button
            onClick={() => setPanelOpen(!panelOpen)}
            className="panel-toggle-btn"
            title={panelOpen ? 'Collapse panel' : 'Expand panel'}
          >
            {panelOpen ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>

        {panelOpen && (
          <div className="panel-body">
            {/* Live Telemetry */}
            <div>
              <div className="section-label">
                <Activity size={12} color="#06b6d4" />
                <span>Live Telemetry</span>
              </div>
              <div className="stat-grid">
                <div className="stat-tile">
                  <div className="stat-tile-title">Round Trip Time</div>
                  <div className="stat-tile-val green">{metrics.rttMs} ms</div>
                </div>
                <div className="stat-tile">
                  <div className="stat-tile-title">Network Jitter</div>
                  <div className="stat-tile-val">±{metrics.jitterMs} ms</div>
                </div>
                <div className="stat-tile">
                  <div className="stat-tile-title">Remote Updates/s</div>
                  <div className="stat-tile-val purple">{metrics.remoteUpdatesPerSec} Hz</div>
                </div>
                <div className="stat-tile">
                  <div className="stat-tile-title">Packets In / Out</div>
                  <div className="stat-tile-val" style={{ fontSize: '12px' }}>
                    {metrics.packetsReceived} / {metrics.packetsSent}
                  </div>
                </div>
              </div>
            </div>

            {/* Interpolation Strategy */}
            <div>
              <div className="section-label">
                <Layers size={12} color="#8b5cf6" />
                <span>Interpolation Strategy</span>
              </div>
              <div className="option-group">
                <div
                  className={`option-card ${interpMode === 'extrapolation' ? 'active' : ''}`}
                  onClick={() => setInterpMode('extrapolation')}
                >
                  <div>
                    <span className="option-name">Dead Reckoning (Extrapolation)</span>
                    <span className="option-desc">Velocity projection; lowest perceived latency</span>
                  </div>
                  <input
                    type="radio"
                    name="interp"
                    checked={interpMode === 'extrapolation'}
                    onChange={() => setInterpMode('extrapolation')}
                  />
                </div>

                <div
                  className={`option-card ${interpMode === 'hermite' ? 'active' : ''}`}
                  onClick={() => setInterpMode('hermite')}
                >
                  <div>
                    <span className="option-name">Catmull-Rom Spline</span>
                    <span className="option-desc">C1 continuous smooth organic curves</span>
                  </div>
                  <input
                    type="radio"
                    name="interp"
                    checked={interpMode === 'hermite'}
                    onChange={() => setInterpMode('hermite')}
                  />
                </div>

                <div
                  className={`option-card ${interpMode === 'lerp' ? 'active' : ''}`}
                  onClick={() => setInterpMode('lerp')}
                >
                  <div>
                    <span className="option-name">Linear LERP</span>
                    <span className="option-desc">Standard buffer interpolation</span>
                  </div>
                  <input
                    type="radio"
                    name="interp"
                    checked={interpMode === 'lerp'}
                    onChange={() => setInterpMode('lerp')}
                  />
                </div>

                <div
                  className={`option-card ${interpMode === 'raw' ? 'active raw' : ''}`}
                  onClick={() => setInterpMode('raw')}
                >
                  <div>
                    <span className="option-name" style={{ color: '#f43f5e' }}>Raw Snapping (No Interp)</span>
                    <span className="option-desc">Demonstrates teleportation and jitter</span>
                  </div>
                  <input
                    type="radio"
                    name="interp"
                    checked={interpMode === 'raw'}
                    onChange={() => setInterpMode('raw')}
                  />
                </div>
              </div>
            </div>

            {/* Render Delay Slider */}
            <div className="slider-wrapper">
              <div className="slider-header">
                <span>Render Buffer Window:</span>
                <span className="slider-val">{bufferDelay} ms</span>
              </div>
              <input
                type="range"
                min="0"
                max="150"
                value={bufferDelay}
                onChange={(e) => setBufferDelay(Number(e.target.value))}
              />
            </div>

            {/* Network Degradation Simulator */}
            <div style={{ paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="section-label" style={{ justifyContent: 'space-between' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Zap size={12} color="#f59e0b" />
                  Network Simulator
                </span>
                {(simLatency > 0 || simJitter > 0 || simLoss > 0) && (
                  <button
                    onClick={() => {
                      setSimLatency(0);
                      setSimJitter(0);
                      setSimLoss(0);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#f43f5e',
                      fontSize: '10px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '3px',
                    }}
                  >
                    <RotateCcw size={10} /> Reset
                  </button>
                )}
              </div>

              <div className="slider-wrapper" style={{ marginBottom: '10px' }}>
                <div className="slider-header">
                  <span>Simulated Lag:</span>
                  <span className="slider-val" style={{ color: '#f59e0b' }}>+{simLatency} ms</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="350"
                  step="25"
                  value={simLatency}
                  onChange={(e) => setSimLatency(Number(e.target.value))}
                />
              </div>

              <div className="slider-wrapper" style={{ marginBottom: '10px' }}>
                <div className="slider-header">
                  <span>Simulated Jitter:</span>
                  <span className="slider-val" style={{ color: '#f59e0b' }}>±{simJitter} ms</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={simJitter}
                  onChange={(e) => setSimJitter(Number(e.target.value))}
                />
              </div>

              <div className="slider-wrapper">
                <div className="slider-header">
                  <span>Packet Loss:</span>
                  <span className="slider-val" style={{ color: '#f43f5e' }}>{simLoss}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="20"
                  value={simLoss}
                  onChange={(e) => setSimLoss(Number(e.target.value))}
                />
              </div>
            </div>

            <button
              onClick={() => roomRef.current?.reconnect()}
              className="reconnect-btn"
            >
              <RefreshCw size={12} />
              <span>Simulate Reconnect Cycle</span>
            </button>
          </div>
        )}
      </aside>

      {/* Viewers Popover Drawer */}
      {presenceOpen && (
        <div className="presence-popover">
          <div className="presence-popover-header">
            <span style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Participants ({activePeers.length + 1})
            </span>
            <button
              onClick={() => setPresenceOpen(false)}
              style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '14px' }}
            >
              ✕
            </button>
          </div>

          <div className="presence-list">
            <div className="peer-row" style={{ borderColor: 'rgba(99, 102, 241, 0.4)' }}>
              <div className="peer-info">
                <div className="color-dot" style={{ backgroundColor: color }} />
                <span>{name} (You)</span>
              </div>
              <span style={{ fontSize: '10px', color: '#10b981', fontFamily: 'var(--font-mono)' }}>online</span>
            </div>

            {activePeers.map((peer) => (
              <div key={peer.clientId} className="peer-row">
                <div className="peer-info">
                  <div className="color-dot" style={{ backgroundColor: peer.color }} />
                  <span>{peer.name}</span>
                </div>
                <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-mono)' }}>active</span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Your Cursor Color:</span>
            <div className="color-palette">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`palette-btn ${color === c ? 'active' : ''}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
