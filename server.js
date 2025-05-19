const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));
let gameInterval = null;

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
      }
    }

    // Kollisioner
    for (const playerId in players) {
      const player = players[playerId];
      if (player.dead) continue;
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const proj = projectiles[i];
        if (proj.owner !== playerId && Math.abs(proj.posx - player.x) < 20 && Math.abs(proj.posy - player.y) < 20) {
          player.health -= 10;
          io.to(playerId).emit("playerHit", { damage: 10, health: player.health });
          projectiles.splice(i, 1);

          if (player.health <= 0) {
            player.dead = true;
            player.deaths += 1;
            if (players[proj.owner]) {
              players[proj.owner].eliminations += 1;
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

io.on("connection", (socket) => {
  console.log("A player connected:", socket.id);

  if (Object.keys(players).length === 0) {
    console.log("Starting game loop");
    startGameLoop();
  }

  socket.emit("requestName");
  console.log("Sent requestName to:", socket.id);

  const nameTimeout = setTimeout(() => {
    if (!players[socket.id]) {
      console.log(`No name received for ${socket.id}, assigning default`);
      // Simulate setPlayerName call
      const defaultName = `Guest_${Math.floor(Math.random() * 1000)}`;
      handleSetPlayerName(socket, defaultName);
    }
  }, 10000);

  function handleSetPlayerName(socket, name) {
    if (players[socket.id]) return;

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
    };

    console.log(`Player ${socket.id} set name to: ${players[socket.id].name}`);

    socket.emit("currentPlayers", players);
    socket.emit("currentProjectiles", projectiles);
    socket.broadcast.emit("newPlayer", { id: socket.id, ...players[socket.id] });
  }

  socket.on("setPlayerName", (name) => {
    console.log("Received setPlayerName:", name);
    clearTimeout(nameTimeout);
    handleSetPlayerName(socket, name);
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
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    clearTimeout(nameTimeout);
    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);

    if (Object.keys(players).length === 0) {
      console.log("No players left, stopping game loop");
      clearInterval(gameInterval);
      gameInterval = null;
      projectiles.length = 0;
    }
  });
});

const PORT = 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
