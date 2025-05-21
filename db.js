const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "", // Update if you have a password
  database: "login_system",
  port: 3306, // Update if MySQL uses a different port
});

// Save game stats
async function saveGameStats(gameid, duration, totalKills) {
  try {
    await pool.query("INSERT INTO game_stats (gameid, game_duration, total_kills) VALUES (?, ?, ?)", [gameid, duration, totalKills]);
    console.log(`Saved game stats for gameid: ${gameid}`);
  } catch (err) {
    console.error("Error saving game stats:", err);
    throw err;
  }
}

// Initialize player stats
async function initializePlayerStats(userId) {
  try {
    await pool.query("INSERT IGNORE INTO player_stats (user_id, eliminations, deaths, playtime) VALUES (?, 0, 0, 0)", [userId]);
    console.log(`Initialized player stats for user_id: ${userId}`);
  } catch (err) {
    console.error("Error initializing player stats:", err);
    throw err;
  }
}

// Update player stats
async function updatePlayerStats(userId, eliminations, deaths, playtime) {
  try {
    await pool.query("UPDATE player_stats SET eliminations = eliminations + ?, deaths = deaths + ?, playtime = playtime + ? WHERE user_id = ?", [eliminations, deaths, playtime, userId]);
    console.log(`Updated player stats for user_id: ${userId}`);
  } catch (err) {
    console.error("Error updating player stats:", err);
    throw err;
  }
}

module.exports = pool;
module.exports.saveGameStats = saveGameStats;
module.exports.initializePlayerStats = initializePlayerStats;
module.exports.updatePlayerStats = updatePlayerStats;
