/**
 * Barreira de início: cada participante chama a função devolvida e só prossegue
 * quando todos chegaram. Sincroniza o disparo concorrente sem `sleep`.
 */
export function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) {
      release();
    }
    await gate;
  };
}
