import type { Asset } from '@shared/schemas/assets.ts';
import type { GameConfig } from '@shared/schemas/game.ts';
import type { ChangeOp } from '@shared/schemas/proposal.ts';
import { toGameAsset } from '@shared/assetsToGame.ts';

/**
 * Ops may bring library assets into a version (a new panel, a celebration
 * sprite, a sound). The packaged entries are always recomputed here from the
 * stored asset records — anything a request sent is replaced — so a client
 * cannot point a game at a file it should not.
 */
export function attachLibraryAssets(ops: ChangeOp[], config: GameConfig, library: Asset[]): ChangeOp[] {
  const byId = new Map(library.map((a) => [a.id, a]));
  const entries = (ids: Array<string | null | undefined>) =>
    [...new Set(ids.filter((id): id is string => Boolean(id) && !Object.prototype.hasOwnProperty.call(config.assets, id!)))]
      .map((id) => byId.get(id))
      .filter((a): a is Asset => Boolean(a))
      .map(toGameAsset);
  return ops.map((op) => {
    if (op.op === 'set-screen-layout') {
      const l = op.layout;
      const ids = [l.design?.backgroundAssetId, ...(l.design?.layers ?? []).map((x) => x.assetId), ...l.objects.map((o) => o.assetId), l.character, l.background, l.panel, l.button];
      return { ...op, layout: { ...l, addAssets: entries(ids) } };
    }
    if (op.op === 'add-animation' || op.op === 'update-animation') {
      return { ...op, addAssets: entries([op.binding.assetId, op.binding.sound?.assetId]) };
    }
    return op;
  });
}
