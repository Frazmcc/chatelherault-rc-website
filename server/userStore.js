const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2), 'utf8')
  }
}

function readUsers() {
  ensureStore()
  const raw = fs.readFileSync(USERS_FILE, 'utf8')
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed.users) ? parsed.users : []
}

function writeUsers(users) {
  ensureStore()
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), 'utf8')
}

function findUserByUsername(username) {
  const users = readUsers()
  return users.find((user) => user.username.toLowerCase() === username.toLowerCase())
}

function addUser(user) {
  const users = readUsers()
  users.push(user)
  writeUsers(users)
}

module.exports = {
  findUserByUsername,
  addUser,
  readUsers,
}
