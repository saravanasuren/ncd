/**
 * API-side wrapper over the shared status machine. Provides
 * `assertTransition` which throws an AppError(409) on an illegal jump —
 * the only sanctioned way statuses change server-side (docs/01 §4).
 */
import {
  canTransition,
  statusLabel,
  type Entity,
} from '@new-wealth/shared';
import { AppError } from './errors.js';

export { canTransition, isTerminal, statusLabel, validTransitions } from '@new-wealth/shared';
export type { Entity } from '@new-wealth/shared';

export function assertTransition(entity: Entity, from: string, to: string): void {
  if (!canTransition(entity, from, to)) {
    throw new AppError(
      'ILLEGAL_TRANSITION',
      409,
      `Cannot move ${entity} from ${statusLabel(entity, from)} to ${statusLabel(entity, to)}`
    );
  }
}
