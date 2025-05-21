const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const pool = require("../db");
const router = express.Router();

// Sign-up
router.post("/signup", [body("username").trim().notEmpty().withMessage("Username is required").isLength({ max: 20 }).withMessage("Username must be 20 characters or less"), body("email").isEmail().withMessage("Invalid email format"), body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters")], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const { username, email, password } = req.body;

  try {
    const [rows] = await pool.query("SELECT id FROM users WHERE username = ? OR email = ?", [username, email]);
    if (rows.length > 0) {
      return res.status(400).json({ error: "Username or email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO users (username, email, password) VALUES (?, ?, ?)", [username, email, hashedPassword]);
    res.json({ success: "Registration successful. Please log in." });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Sign-in
router.post("/login", [body("email").isEmail().withMessage("Invalid email format"), body("password").notEmpty().withMessage("Password is required")], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const { email, password } = req.body;

  try {
    const [rows] = await pool.query("SELECT id, username, password FROM users WHERE email = ?", [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, "your_jwt_secret", { expiresIn: "1h" });
    res.cookie("token", token, { httpOnly: true });
    res.json({ success: "Login successful", redirect: "/game.html" });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Logout
router.get("/logout", (req, res) => {
  res.clearCookie("token");
  res.redirect("/");
});

// Get username
router.get("/getUsername", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ username: "Guest" });

  jwt.verify(token, "your_jwt_secret", (err, user) => {
    if (err) return res.json({ username: "Guest" });
    res.json({ username: user.username });
  });
});

module.exports = router;
