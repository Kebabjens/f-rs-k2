const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));
let gameInterval = null;

const players = {};
const projectiles = [];
const GAME_LOOP_INTERVAL = 1000 / 60; // 60 FPS

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
    // Update all projectiles
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const proj = projectiles[i];
      proj.posx += proj.dirx * proj.speed;
      proj.posy += proj.diry * proj.speed;

      // Remove projectiles that are out of bounds
      if (proj.posx < 0 || proj.posx > 800 || proj.posy < 0 || proj.posy > 600) {
        projectiles.splice(i, 1);
      }
    }

    // Check for collisions
    for (const playerId in players) {
      const player = players[playerId];
      if (player.dead) continue; // Skip dead players
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const proj = projectiles[i];
        if (proj.owner !== playerId && Math.abs(proj.posx - player.x) < 20 && Math.abs(proj.posy - player.y) < 20) {
          player.health -= 10; // Deal 10 damage
          io.to(playerId).emit("playerHit", { damage: 10, health: player.health });
          projectiles.splice(i, 1); // Remove projectile on hit

          // Handle player death
          if (player.health <= 0) {
            player.dead = true; // Mark as dead
            player.deaths += 1; // Increment deaths
            if (players[proj.owner]) {
              players[proj.owner].eliminations += 1; // Increment shooter’s eliminations
            }
            io.to(playerId).emit("playerDied"); // Notify client of death
          }
        }
      }
    }

    // Broadcast game state
    io.emit("gameUpdate", {
      players: players,
      projectiles: projectiles,
    });
  }, GAME_LOOP_INTERVAL);
}

io.on("connection", (socket) => {
  console.log("A player connected:", socket.id);

  // Start game loop when first connection is made
  if (Object.keys(players).length === 0) {
    startGameLoop();
  }

  // Request player name
  socket.emit("requestName");
  console.log("Sent requestName to:", socket.id);

  // Fallback: Assign default name after 10 seconds
  const nameTimeout = setTimeout(() => {
    if (!players[socket.id]) {
      console.log(`No name received for ${socket.id}, assigning default`);
      socket.emit("setPlayerName", `Guest_${Math.floor(Math.random() * 1000)}`);
    }
  }, 10000);

  // Handle player name
  socket.on("setPlayerName", (name) => {
    clearTimeout(nameTimeout); // Cancel timeout
    if (players[socket.id]) return; // Prevent duplicate player creation

    // Initialize new player
    players[socket.id] = {
      x: Math.random() * 800,
      y: Math.random() * 600,
      health: 100,
      color: `hsl(${Math.random() * 360}, 70%, 50%)`, // Random color
      lastShot: 0, // Track last shot time
      fireCD: 250, // Cooldown in milliseconds
      name: typeof name === "string" && name.trim().length > 0 && name.length <= 20 ? name.trim() : `Guest_${Math.floor(Math.random() * 1000)}`,
      eliminations: 0, // Track kills
      deaths: 0, // Track deaths
      dead: false, // Track dead/alive state
    };

    console.log(`Player ${socket.id} set name to: ${players[socket.id].name}`);

    // Send current game state to new player
    socket.emit("currentPlayers", players);
    socket.emit("currentProjectiles", projectiles);
    // Broadcast new player to others
    socket.broadcast.emit("newPlayer", { id: socket.id, ...players[socket.id] });
  });

  // Handle player movement
  socket.on("playerMovement", (movement) => {
    if (!players[socket.id] || players[socket.id].dead) return;

    const player = players[socket.id];
    const speed = 5;

    if (movement.w) player.y -= speed;
    if (movement.a) player.x -= speed;
    if (movement.s) player.y += speed;
    if (movement.d) player.x += speed;

    // Keep player within bounds
    player.x = Math.max(0, Math.min(800, player.x));
    player.y = Math.max(0, Math.min(600, player.y));

    // Broadcast updated position
    io.emit("playerMoved", { id: socket.id, x: player.x, y: player.y });
  });

  socket.on("playerShoot", (shoot) => {
    if (!players[socket.id] || players[socket.id].dead) return;

    const player = players[socket.id];
    const currentTime = Date.now();

    // Check cooldown
    if (currentTime - player.lastShot < player.fireCD) {
      return; // Ignore shot if cooldown hasn't elapsed
    }

    let dirx = 0;
    let diry = 0;

    if (shoot.up) diry--;
    if (shoot.down) diry++;
    if (shoot.left) dirx--;
    if (shoot.right) dirx++;

    // Only create projectile if direction is set
    if (dirx !== 0 || diry !== 0) {
      // Normalize direction
      const length = Math.sqrt(dirx * dirx + diry * diry);
      dirx /= length;
      diry /= length;
      const projectile = new Projectile(player.x, player.y, dirx, diry, socket.id);
      projectiles.push(projectile);
      player.lastShot = currentTime; // Update last shot time
    }
  });

  // Handle player respawn
  socket.on("playerRespawn", () => {
    if (!players[socket.id] || !players[socket.id].dead) return;
    const player = players[socket.id];
    player.health = 100; // Reset health
    player.x = Math.random() * 800; // Random position
    player.y = Math.random() * 600;
    player.dead = false; // Mark as alive
    io.to(socket.id).emit("respawnConfirmed", { x: player.x, y: player.y, health: player.health });
    io.emit("playerMoved", { id: socket.id, x: player.x, y: player.y }); // Update position for all clients
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    clearTimeout(nameTimeout);
    delete players[socket.id];
    io.emit("playerDisconnected", socket.id);

    // Stop game loop if no players left
    if (Object.keys(players).length === 0) {
      clearInterval(gameInterval);
      gameInterval = null;
      projectiles.length = 0; // Clear all projectiles
    }
  });
});

const PORT = 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
