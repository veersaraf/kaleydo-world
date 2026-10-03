// Tennis scoring: love-15-30-40, deuce/advantage, games, best-of-N games.

const NAMES = ['Love', 'Fifteen', 'Thirty', 'Forty'];
const SHORT = ['0', '15', '30', '40'];
const COUNT = ['Love', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

export interface PointOutcome {
  gameWon: boolean;
  matchWon: boolean;
  /** announcer text, e.g. "Thirty–Fifteen", "Deuce", "Game" */
  call: string;
}

export class Score {
  points: [number, number] = [0, 0];
  games: [number, number] = [0, 0];
  server: 0 | 1;
  /** doubles: which member of each team serves next */
  serverIdx: [number, number] = [0, 0];
  faults = 0;
  winner: -1 | 0 | 1 = -1;
  totalGames = 0;
  /**
   * A race to this many points instead of tennis scoring (the phone preview's short match): one game,
   * no deuce, the serve changing every point. 0 = ordinary scoring.
   */
  race = 0;

  constructor(
    public gamesToWin: number,
    firstServer: 0 | 1,
    public names: [string, string],
  ) {
    this.server = firstServer;
  }

  get deuceCourt() {
    return (this.points[0] + this.points[1]) % 2 === 0;
  }

  isDeuce() {
    return this.points[0] >= 3 && this.points[1] >= 3 && this.points[0] === this.points[1];
  }

  advantage(): -1 | 0 | 1 {
    const [a, b] = this.points;
    if (a >= 3 && b >= 3 && Math.abs(a - b) === 1) return a > b ? 0 : 1;
    return -1;
  }

  /** Is the next point a game point for `team`? */
  gamePointFor(team: 0 | 1) {
    if (this.race) return this.points[team] + 1 >= this.race;
    const me = this.points[team];
    const them = this.points[1 - team];
    return me >= 3 && me - them >= 1;
  }

  matchPointFor(team: 0 | 1) {
    return this.gamePointFor(team) && this.games[team] + 1 >= this.gamesToWin;
  }

  pointTo(team: 0 | 1): PointOutcome {
    this.faults = 0;
    this.points[team]++;
    const me = this.points[team];
    const them = this.points[1 - team];
    if (this.race) {
      if (me >= this.race) {
        this.games[team]++;
        this.totalGames++;
        this.winner = team;
        return { gameWon: true, matchWon: true, call: 'Game, set and match' };
      }
      this.server = (1 - this.server) as 0 | 1;
      return { gameWon: false, matchWon: false, call: this.call() };
    }
    if (me >= 4 && me - them >= 2) {
      this.games[team]++;
      this.totalGames++;
      this.points = [0, 0];
      const matchWon = this.games[team] >= this.gamesToWin;
      if (matchWon) this.winner = team;
      else {
        // service alternates every game; doubles partners alternate too
        this.serverIdx[this.server] = 1 - this.serverIdx[this.server];
        this.server = (1 - this.server) as 0 | 1;
      }
      return { gameWon: true, matchWon, call: matchWon ? 'Game, set and match' : 'Game' };
    }
    return { gameWon: false, matchWon: false, call: this.call() };
  }

  /** Umpire call, server's score first. */
  call(): string {
    const s = this.server;
    const a = this.points[s];
    const b = this.points[1 - s];
    if (this.race) return a === b ? `${COUNT[Math.min(9, a)]} all` : `${COUNT[Math.min(9, a)]}–${COUNT[Math.min(9, b)]}`;
    if (a >= 3 && b >= 3) {
      if (a === b) return 'Deuce';
      return `Advantage ${this.names[a > b ? s : 1 - s]}`;
    }
    if (a === b) return `${NAMES[a]} all`;
    return `${NAMES[a]}–${NAMES[b]}`;
  }

  /** Short scoreboard text for a team. */
  pointText(team: 0 | 1): string {
    if (this.race) return String(this.points[team]);
    const me = this.points[team];
    const them = this.points[1 - team];
    if (me >= 3 && them >= 3) {
      if (me === them) return '40';
      return me > them ? 'AD' : '40';
    }
    return SHORT[Math.min(3, me)];
  }
}
