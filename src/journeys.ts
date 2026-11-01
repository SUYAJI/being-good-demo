import type { RTP } from './types';

export type JourneyTarget = {
  schema_id: 'bg.trajectory-target.v1'; interpolation: 'linear-even-order-v1';
  waypoints: RTP[]; requested_count: number;
};
export type Recipe = { id: string; name: string; revision: number; target: JourneyTarget; created: number; updated: number };
export type TargetSnapshot = JourneyTarget & { recipe: Pick<Recipe, 'id' | 'name' | 'revision'> | null };
export const journeyTarget = (waypoints: RTP[], count: number): JourneyTarget => ({
  schema_id: 'bg.trajectory-target.v1', interpolation: 'linear-even-order-v1',
  waypoints: waypoints.map(point => ({ ...point })), requested_count: count,
});
