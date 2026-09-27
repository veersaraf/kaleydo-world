// Balloon colours and size: the game's, from src/tv/archery/layouts.ts on the
// archery game's branch. Kept identical here until the branches merge (then
// this can simply re-export layouts.ts): the range paints each balloon
// balloonColor(id), the same colour the game's 'pop' confetti uses.

export const BALLOON_COLORS = ['#ff4d6d', '#ffbe0b', '#3a86ff', '#8ac926', '#c77dff', '#ff7b00'];
export const balloonColor = (id: number) => BALLOON_COLORS[((id % BALLOON_COLORS.length) + BALLOON_COLORS.length) % BALLOON_COLORS.length];
export const BALLOON_R = 0.28;
