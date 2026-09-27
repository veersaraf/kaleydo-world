// The suggested gameplay camera for archery (the preview's 'play' and 'aim'
// cameras): behind the archer and out past the draw shoulder, at about head
// height, looking down the aim. It swings round the archer with the aim's yaw,
// so the archer stays in the lower corner (their bow arm and bow at the lower
// side) and the target in the middle wherever they aim; zooming narrows the
// field of view onto the aim without moving the camera, as Wii Sports Resort
// pushes in while you draw. Pure maths on the ArcherState: damp towards it in
// the game's camera.

import { RANGE } from './range';
import type { ArcherState } from './types';

export interface AimCam {
  /** where the camera is, and the point it looks at (world metres) */
  x: number;
  y: number;
  z: number;
  lx: number;
  ly: number;
  lz: number;
  /** vertical field of view, degrees (for 16:9; keep the horizontal one on narrower screens) */
  fov: number;
}

export const AIM_CAM = {
  /** out past the draw shoulder, behind, and the height */
  side: 1.5,
  back: 3.4,
  height: 1.62,
  /** how far down the aim it looks */
  look: 22,
  /** field of view unzoomed / fully zoomed */
  fov: 40,
  zoomFov: 22,
};

export function newAimCam(): AimCam {
  return { x: 0, y: AIM_CAM.height, z: RANGE.lineZ + AIM_CAM.back, lx: 0, ly: RANGE.eyeY, lz: RANGE.lineZ - AIM_CAM.look, fov: AIM_CAM.fov };
}

/**
 * The camera for archer `s` (into `out`, which it returns). `zoom` 0..1 — for
 * example the draw while drawing and holding, easing back out after the shot.
 * Aiming phases follow the aim; idle, cheer and sad look straight down the
 * range.
 */
export function aimCamera(s: ArcherState, zoom: number, out: AimCam = newAimCam()): AimCam {
  const aiming = s.phase !== 'idle' && s.phase !== 'cheer' && s.phase !== 'sad';
  const yaw = aiming ? s.yaw : 0;
  const pitch = aiming ? s.pitch : 0;
  // forward along the aim (yaw 0 = −z, + = left) and the archer's right of it
  const fx = -Math.sin(yaw),
    fz = -Math.cos(yaw);
  const rx = Math.cos(yaw),
    rz = -Math.sin(yaw);
  const side = s.handed * AIM_CAM.side;
  out.x = s.x + rx * side - fx * AIM_CAM.back;
  out.y = AIM_CAM.height;
  out.z = s.z + rz * side - fz * AIM_CAM.back;
  const D = AIM_CAM.look;
  out.lx = s.x + fx * D * Math.cos(pitch);
  out.ly = RANGE.eyeY - 0.1 + Math.sin(pitch) * D;
  out.lz = s.z + fz * D * Math.cos(pitch);
  const k = Math.min(1, Math.max(0, zoom));
  out.fov = AIM_CAM.fov + (AIM_CAM.zoomFov - AIM_CAM.fov) * k;
  return out;
}
