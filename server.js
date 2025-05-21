const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cookieParser = require("cookie-parser");
const authRoutes = require("./routes/auth");
const authenticateToken = require("./middleware/auth");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`Request: ${req.method} ${req.url}`);
  next();
});

// Serve index.html for root route
app.get("/", (req, res) => {
  console.log("Serving index.html");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(authRoutes);

// Get username route
app.get("/getUsername", authenticateToken, (req, res) => {
  res.json({ username: req.user.username });
});

// Protect game route
app.get("/game.html", authenticateToken, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "game.html"));
});

let gameInterval = null;
let gameId = null;
let gameStartTime = null;
const players = {};
const projectiles = [];
const GAME_LOOP_INTERVAL = 1000 / 60;

class Projectile {
  constructor(startposx, startposy, dirx, diry, owner) {
    this.posx = startposx;
    this.posy = startposy;
    this.dirx = dirx;
    this.diry = diry;
    this.owner = owner;
    this.speed = 10;
  }
}

function startGameLoop() {
  if (gameInterval) clearInterval(gameInterval);

  gameInterval = setInterval(() => {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const proj = projectiles[i];
      proj.posx += proj.dirx * proj.speed;
      proj.posy += proj.diry * proj.speed;

      if (proj.posx < 0 || proj.posx > 800 || proj.posy < 0 || proj.posy > 600) {
        projectiles.splice(i, 1);
        console.log(`Projectile ${i} removed (out of bounds)`);
      }
    }

    for (const playerId in players) {
      const player = players[playerId];
      if (player.dead) continue;
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const proj = projectiles[i];
        if (proj.owner !== playerId && Math.abs(proj.posx - player.x) < 20 && Math.abs(proj.posy - player.y) < 20) {
          player.health -= 10;
          console.log(`Player ${playerId} hit by ${proj.owner}. Health: ${player.health}`);
          io.to(playerId).emit("playerHit", { damage: 10, health: player.health });
          projectiles.splice(i, 1);

          if (player.health <= 0) {
            player.dead = true;
            player.deaths += 1;
            console.log(`Player ${playerId} died. Deaths: ${player.deaths}`);
            if (proj.owner && players[proj.owner] && !players[proj.owner].dead && proj.owner !== playerId) {
              players[proj.owner].eliminations += 1;
              console.log(`Player ${proj.owner} killed ${playerId}. Eliminations: ${players[proj.owner].eliminations}`);
            } else {
              console.log(`No elimination credited for ${playerId}'s death (owner: ${proj.owner}, valid: ${!!players[proj.owner]}, dead: ${players[proj.owner]?.dead}, self: ${proj.owner === playerId})`);
            }
            io.to(playerId).emit("playerDied");
          }
        }
      }
    }

    io.emit("gameUpdate", {
      players: players,
      projectiles: projectiles,
    });
  }, GAME_LOOP_INTERVAL);
}

async function endGame(disconnectedPlayers) {
  if (!gameId || !gameStartTime) return;

  const duration = Math.floor((Date.now() - gameStartTime) / 1000);
  const totalKills = Object.values(disconnectedPlayers).reduce((sum, player) => sum + (player.eliminations || 0), 0);

  console.log(`Ending game ${gameId}. Duration: ${duration}s, Total Kills: ${totalKills}`);

  try {
    await db.saveGameStats(gameId, duration, totalKills);
    console.log(`Saved game stats for gameid: ${gameId}`);
  } catch (err) {
    console.error("Failed to save game stats:", err);
  }

  gameId = null;
  gameStartTime = null;
  clearInterval(gameInterval);
  gameInterval = null;
  projectiles.length = 0;
}

io.on("connection", (socket) => {
  console.log("A player connected:", socket.id);

  if (Object.keys(players).length === 0) {
    console.log("Starting new game session");
    gameId = uuidv4();
    gameStartTime = Date.now();
    startGameLoop();
  }

  socket.emit("requestName");
  console.log("Sent requestName to:", socket.id);

  const nameTimeout = setTimeout(() => {
    if (!players[socket.id]) {
      console.log(`No name received for ${socket.id}, assigning default`);
      const defaultName = `Guest_${Math.floor(Math.random() * 1000)}`;
      handleSetPlayerName(socket, defaultName, null, null);
    }
  }, 10000);

  async function handleSetPlayerName(socket, name, userId, username) {
    if (players[socket.id]) return;

    if (userId && username) {
      try {
        await db.initializePlayerStats(userId, username);
      } catch (err) {
        console.error(`Failed to initialize stats for user_id: ${userId}, username: ${username}`, err);
      }
    }

    players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      health: 100,
      color: `hsl(${Math.random() * 360}, 70%, 50%)`,
      lastShot: 0,
      fireCD: 250,
      name: typeof name === "string" && name.trim().length > 0 && name.length <= 20 ? name.trim() : `Guest_${Math.floor(Math.random() * 1000)}`,
      eliminations: 0,
      deaths: 0,
      dead: false,
      userId: userId,
      username: username,
      sessionStartTime: Date.now(),
    };

    console.log(`Player ${socket.id} set name to: ${players[socket.id].name}, userId: ${userId || "Guest"}, username: ${username || "Guest"}`);

    socket.emit("currentPlayers", players);
    socket.emit("currentProjectiles", projectiles);
    socket.broadcast.emit("newPlayer", { id: socket.id, ...players[socket.id] });
  }

  socket.on("setPlayerName", async (name) => {
    console.log("Received setPlayerName:", name);
    clearTimeout(nameTimeout);

    const token = socket.handshake.headers.cookie
      ?.split("; ")
      .find((row) => row.startsWith("token="))
      ?.split("=")[1];
    let userId = null;
    let username = null;
    if (token) {
      try {
        const jwt = require("jsonwebtoken");
        const decoded = jwt.verify(token, "your_jwt_secret");
        userId = decoded.id;
        username = decoded.username;
        console.log(`JWT decoded: userId=${userId}, username=${username}`);
      } catch (err) {
        console.error("Invalid token:", err);
      }
    }

    await handleSetPlayerName(socket, name, userId, username);
  });

  socket.on("playerMovement", (movement) => {
    if (!players[socket.id] || players[socket.id].dead) return;

    const player = players[socket.id];
    const speed = 5;

    if (movement.w) player.y -= speed;
    if (movement.a) player.x -= speed;
    if (movement.s) player.y += speed;
    if (movement.d) player.x += speed;

    player.x = Math.max(0, Math.min(800, player.x));
    player.y = Math.max(0, Math.min(600, player.y));

    io.emit("playerMoved", { id: socket.id, x: player.x, y: player.y });
  });

  socket.on("playerShoot", (shoot) => {
    if (!players[socket.id] || players[socket.id].dead) return;

    const player = players[socket.id];
    const currentTime = Date.now();

    if (currentTime - player.lastShot < player.fireCD) {
      return;
    }

    let dirx = 0;
    let diry = 0;

    if (shoot.up) diry--;
    if (shoot.down) diry++;
    if (shoot.left) dirx--;
    if (shoot.right) dirx++;

    if (dirx !== 0 || diry !== 0) {
      const length = Math.sqrt(dirx * dirx + diry * diry);
      dirx /= length;
      diry /= length;
      const projectile = new Projectile(player.x, player.y, dirx, diry, socket.id);
      projectiles.push(projectile);
      player.lastShot = currentTime;
      console.log(`Player ${socket.id} shot projectile`);
    }
  });

  socket.on("playerRespawn", () => {
    if (!players[socket.id] || !players[socket.id].dead) return;
    const player = players[socket.id];
    player.health = 100;
    player.x = Math.random() * 800;
    player.y = Math.random() * 600;
    player.dead = false;
    io.to(socket.id).emit("respawnConfirmed", { x: player.x, y: player.y, health: player.health });
    io.emit("playerMoved", { id: socket.id, x: player.x, y: player.y });
    console.log(`Player ${socket.id} respawned`);
  });

  socket.on("disconnect", async () => {
    console.log("Player disconnected:", socket.id);
    const disconnectedPlayer = players[socket.id];
    if (!disconnectedPlayer) return;

    const sessionDuration = Math.floor((Date.now() - disconnectedPlayer.sessionStartTime) / 1000);
    const userId = disconnectedPlayer.userId;
    const username = disconnectedPlayer.username;

    if (userId && username) {
      console.log(`Saving stats for user_id: ${userId}, username: ${username}, eliminations: ${disconnectedPlayer.eliminations}, deaths: ${disconnectedPlayer.deaths}, playtime: ${sessionDuration}`);
      try {
        await db.updatePlayerStats(userId, username, disconnectedPlayer.eliminations, disconnectedPlayer.deaths, sessionDuration);
      } catch (err) {
        console.error(`Failed to update stats for user_id: ${userId}`, err);
      }
    }

    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);

    if (Object.keys(players).length === 0) {
      console.log("No players left, ending game session");
      await endGame({ [socket.id]: disconnectedPlayer });
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
