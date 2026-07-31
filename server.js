import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Helper to generate 6-digit room code and passwords
function generateRandomRoomCredentials(customRoomId) {
  const roomId = customRoomId || Math.floor(100000 + Math.random() * 900000).toString();
  const playerPassword = Math.floor(1000 + Math.random() * 9000).toString();
  const couplePassword = Math.floor(1000 + Math.random() * 9000).toString();
  return { roomId, playerPassword, couplePassword };
}

// Default initial state letters
const defaultLetters = {
  1: ["B", "H", "O", "V", "Q", "Y", "E", "P", "R", "Ô", "L", "U", "N", "M", "T", "A", "G", "Ă", "I", "C"],
  2: ["D", "X", "V", "E", "K", "G", "C", "T", "Â", "Q", "R", "Ô", "I", "Ă", "Ê", "Ư", "Đ", "A", "O", "H"],
  3: ["P", "H", "U", "A", "I", "Y", "Ê", "Ơ", "T", "B", "C", "N", "L", "Ă", "O", "X", "G", "M", "Đ", "R"]
};

function createNewRoundState(letters, isRound3 = false) {
  return {
    visible: false,
    letters: [...letters],
    cellColors: Array(20).fill(isRound3 ? 'white' : 'yellow'),
    selectedIndices: [],
    showAnimKey: 0
  };
}

const rooms = new Map();

function getOrCreateRoom(roomId) {
  const cleanId = String(roomId).trim();
  if (!rooms.has(cleanId)) {
    const credentials = generateRandomRoomCredentials(cleanId);
    const newRoom = {
      credentials,
      currentRound: 1,
      roundBoards: {
        1: createNewRoundState(defaultLetters[1]),
        2: createNewRoundState(defaultLetters[2]),
        3: createNewRoundState(defaultLetters[3], true)
      },
      buzzer: {
        locked: true,
        pressedBy: null
      },
      timer: {
        seconds: 60,
        running: false
      },
      timerInterval: null
    };
    rooms.set(cleanId, newRoom);
  }
  return rooms.get(cleanId);
}

// Pre-initialize default room 123456
getOrCreateRoom('123456');

// Hexagon connectivity helpers
function getHexNeighbors(index) {
  const col = Math.floor(index / 4);
  const row = index % 4;
  const neighbors = [];

  const offsets = (col % 2 === 0) 
    ? [
        [0, -1], [0, 1],
        [-1, -1], [-1, 0],
        [1, -1], [1, 0]
      ]
    : [
        [0, -1], [0, 1],
        [-1, 0], [-1, 1],
        [1, 0], [1, 1]
      ];

  for (const [dc, dr] of offsets) {
    const nc = col + dc;
    const nr = row + dr;
    if (nc >= 0 && nc < 5 && nr >= 0 && nr < 4) {
      neighbors.push(nc * 4 + nr);
    }
  }
  return neighbors;
}

function hasConnectingPath(cellColors, targetColor, orientation) {
  if (!cellColors || cellColors.length !== 20) return false;
  const queue = [];
  const visited = new Set();

  if (orientation === 'LR') {
    for (let row = 0; row < 4; row++) {
      const idx = 0 * 4 + row;
      if (cellColors[idx] === targetColor) {
        queue.push(idx);
        visited.add(idx);
      }
    }
  } else if (orientation === 'TB') {
    for (let col = 0; col < 5; col++) {
      const idx = col * 4 + 0;
      if (cellColors[idx] === targetColor) {
        queue.push(idx);
        visited.add(idx);
      }
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const currCol = Math.floor(current / 4);
    const currRow = current % 4;

    if (orientation === 'LR' && currCol === 4) return true;
    if (orientation === 'TB' && currRow === 3) return true;

    for (const nbr of getHexNeighbors(current)) {
      if (!visited.has(nbr) && cellColors[nbr] === targetColor) {
        visited.add(nbr);
        queue.push(nbr);
      }
    }
  }

  return false;
}

function checkAndApplyWinCondition(room) {
  const r = room.currentRound;
  const board = room.roundBoards[r];
  if (!board || !board.visible) return;

  if (r === 1 || r === 2) {
    const blueWin = hasConnectingPath(board.cellColors, 'blue', 'LR');
    const whiteWin = hasConnectingPath(board.cellColors, 'white', 'TB');
    if (blueWin || whiteWin) {
      room.flashEffect = { type: 'green', expireTime: Date.now() + 5000 };
    }
  } else if (r === 3) {
    const yellowWin = hasConnectingPath(board.cellColors, 'yellow', 'LR');
    if (yellowWin) {
      room.flashEffect = { type: 'green', expireTime: Date.now() + 5000 };
    }
  }
}

function sanitizeRoomState(room) {
  return {
    credentials: room.credentials,
    currentRound: room.currentRound,
    roundBoards: room.roundBoards,
    buzzer: room.buzzer,
    timer: {
      seconds: room.timer.seconds,
      running: room.timer.running
    },
    flashEffect: room.flashEffect || null
  };
}

function startTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timer.running = true;
  io.to(roomId).emit('state:update', sanitizeRoomState(room));

  room.timerInterval = setInterval(() => {
    if (room.timer.running && room.timer.seconds > 0) {
      room.timer.seconds -= 1;
      io.to(roomId).emit('timer:tick', { seconds: room.timer.seconds });
      if (room.timer.seconds <= 0) {
        room.timer.running = false;
        if (room.timerInterval) clearInterval(room.timerInterval);
        room.timerInterval = null;

        // Check failure condition for Round 3 timeout
        if (room.currentRound === 3) {
          const yellowWin = hasConnectingPath(room.roundBoards[3].cellColors, 'yellow', 'LR');
          if (!yellowWin) {
            if (room.roundBoards[3].selectedIndices && room.roundBoards[3].selectedIndices.length > 0) {
              room.roundBoards[3].selectedIndices.forEach(idx => {
                room.roundBoards[3].cellColors[idx] = 'black';
              });
              room.roundBoards[3].selectedIndices = [];
            }
            room.flashEffect = { type: 'red', expireTime: Date.now() + 5000 };
          }
        }

        io.to(roomId).emit('state:update', sanitizeRoomState(room));
      }
    }
  }, 1000);
}

function pauseTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.timer.running = false;
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  io.to(roomId).emit('state:update', sanitizeRoomState(room));
}

function resetTimer(roomId) {
  pauseTimer(roomId);
  const room = rooms.get(roomId);
  if (!room) return;
  room.timer.seconds = 60;
  io.to(roomId).emit('state:update', sanitizeRoomState(room));
}

// API Endpoints
app.post('/api/verify-login', (req, res) => {
  const { role, roomId, password } = req.body || {};

  if (!roomId || !password || !role) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ thông tin!' });
  }

  const cleanRoomId = String(roomId).trim();
  const room = rooms.get(cleanRoomId);

  if (!room) {
    return res.status(401).json({ success: false, message: 'Mã phòng không tồn tại hoặc chưa được tạo!' });
  }

  const credentials = room.credentials;
  const targetRole = String(role).toLowerCase();

  if (targetRole === 'player') {
    if (String(password).trim() === String(credentials.playerPassword).trim()) {
      return res.json({
        success: true,
        redirectUrl: `/Player.html?roomid=${encodeURIComponent(credentials.roomId)}&auth=${encodeURIComponent(credentials.playerPassword)}`
      });
    } else {
      return res.status(401).json({ success: false, message: 'Mật khẩu Player không chính xác!' });
    }
  } else if (targetRole === 'couple') {
    if (String(password).trim() === String(credentials.couplePassword).trim()) {
      return res.json({
        success: true,
        redirectUrl: `/Couple.html?roomid=${encodeURIComponent(credentials.roomId)}&auth=${encodeURIComponent(credentials.couplePassword)}`
      });
    } else {
      return res.status(401).json({ success: false, message: 'Mật khẩu Couple không chính xác!' });
    }
  } else {
    return res.status(400).json({ success: false, message: 'Vai trò không hợp lệ!' });
  }
});

// Explicit Static Routes
app.get(['/', '/index', '/index.html'], (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/controller', '/Controller', '/Controller.html'], (_req, res) => res.sendFile(path.join(__dirname, 'Controller.html')));
app.get(['/viewer', '/Viewer', '/Viewer.html'], (_req, res) => res.sendFile(path.join(__dirname, 'Viewer.html')));
app.get(['/host', '/Host', '/Host.html'], (_req, res) => res.sendFile(path.join(__dirname, 'Host.html')));
app.get(['/player', '/Player', '/Player.html'], (_req, res) => res.sendFile(path.join(__dirname, 'Player.html')));
app.get(['/couple', '/Couple', '/Couple.html'], (_req, res) => res.sendFile(path.join(__dirname, 'Couple.html')));

app.use(express.static(__dirname));

// Socket.IO Events with Strict Room Scoping
io.on('connection', (socket) => {
  let joinedRoomId = null;

  socket.on('join:room', ({ roomId }) => {
    if (roomId) {
      const cleanId = String(roomId).trim();
      joinedRoomId = cleanId;
      socket.join(cleanId);
      const room = getOrCreateRoom(cleanId);
      socket.emit('state:update', sanitizeRoomState(room));
    }
  });

  socket.on('get:state', ({ roomId } = {}) => {
    const rId = roomId ? String(roomId).trim() : joinedRoomId;
    if (rId && rooms.has(rId)) {
      socket.emit('state:update', sanitizeRoomState(rooms.get(rId)));
    }
  });

  // Controller requests a brand new room
  socket.on('credentials:generate', () => {
    const newCreds = generateRandomRoomCredentials();
    const newRoom = getOrCreateRoom(newCreds.roomId);

    if (joinedRoomId) {
      socket.leave(joinedRoomId);
    }
    joinedRoomId = newCreds.roomId;
    socket.join(newCreds.roomId);

    io.to(newCreds.roomId).emit('state:update', sanitizeRoomState(newRoom));
  });

  // Round Switch
  socket.on('round:switch', (round) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (room && [1, 2, 3].includes(round)) {
      room.currentRound = round;
      room.flashEffect = null;
      io.to(joinedRoomId).emit('state:update', sanitizeRoomState(room));
    }
  });

  // Show Board (Hiện bảng)
  socket.on('board:show', (round) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    const r = round || room.currentRound;
    const letters = [...room.roundBoards[r].letters];
    for (let i = letters.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    room.roundBoards[r].letters = letters;
    room.roundBoards[r].visible = true;
    room.roundBoards[r].cellColors = Array(20).fill(r === 3 ? 'white' : 'yellow');
    room.roundBoards[r].selectedIndices = [];
    room.roundBoards[r].showAnimKey = Date.now();
    room.flashEffect = null;
    io.to(joinedRoomId).emit('state:update', sanitizeRoomState(room));
  });

  // Toggle cell select
  socket.on('board:toggle_cell_select', ({ round, index }) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    const r = round || room.currentRound;
    const board = room.roundBoards[r];
    if (board && index >= 0 && index < 20) {
      if (!board.selectedIndices) board.selectedIndices = [];
      const pos = board.selectedIndices.indexOf(index);
      if (pos > -1) {
        board.selectedIndices.splice(pos, 1);
      } else {
        board.selectedIndices.push(index);
      }
      io.to(joinedRoomId).emit('state:update', sanitizeRoomState(room));
    }
  });

  // Color cells
  socket.on('board:color_cells', ({ round, indices, color }) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    const r = round || room.currentRound;
    const board = room.roundBoards[r];
    if (board && Array.isArray(indices)) {
      indices.forEach(idx => {
        if (idx >= 0 && idx < 20) {
          board.cellColors[idx] = color;
        }
      });
      board.selectedIndices = [];
      checkAndApplyWinCondition(room);
      io.to(joinedRoomId).emit('state:update', sanitizeRoomState(room));
    }
  });

  // Buzzer events
  socket.on('buzzer:control', (action) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    if (action === 'open') {
      room.buzzer.locked = false;
    } else if (action === 'lock') {
      room.buzzer.locked = true;
    } else if (action === 'reset_open') {
      room.buzzer.locked = false;
      room.buzzer.pressedBy = null;
    } else if (action === 'reset_lock') {
      room.buzzer.locked = true;
      room.buzzer.pressedBy = null;
    }
    io.to(joinedRoomId).emit('state:update', sanitizeRoomState(room));
  });

  socket.on('buzzer:press', ({ team }) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    if (!room.buzzer.locked && !room.buzzer.pressedBy) {
      if (team === 'player' || team === 'couple') {
        room.buzzer.pressedBy = team;
        room.buzzer.locked = true;
        io.to(joinedRoomId).emit('state:update', sanitizeRoomState(room));
        io.to(joinedRoomId).emit('buzzer:alert', { team });
      }
    }
  });

  // Timer events
  socket.on('timer:control', (action) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    if (action === 'start') {
      if (room.timer.seconds <= 0) room.timer.seconds = 60;
      startTimer(joinedRoomId);
    } else if (action === 'pause') {
      pauseTimer(joinedRoomId);
    } else if (action === 'continue') {
      if (room.timer.seconds > 0) startTimer(joinedRoomId);
    } else if (action === 'reset') {
      resetTimer(joinedRoomId);
    }
  });

  // Excel Upload
  socket.on('excel:upload', (base64Data) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const workbook = XLSX.read(buffer, { type: 'buffer' });

      const sheetNames = workbook.SheetNames;
      let sheet1 = sheetNames.find(s => s.toLowerCase().includes('1') || s.toLowerCase().includes('vòng 1')) || sheetNames[0];
      let sheet2 = sheetNames.find(s => s.toLowerCase().includes('2') || s.toLowerCase().includes('vòng 2')) || sheetNames[1];
      let sheet3 = sheetNames.find(s => s.toLowerCase().includes('đặc biệt') || s.toLowerCase().includes('3') || s.toLowerCase().includes('vòng đặc biệt')) || sheetNames[2];

      const parseLettersFromSheet = (sheetName) => {
        if (!sheetName || !workbook.Sheets[sheetName]) return null;
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        const result = [];
        for (let i = 0; i < data.length; i++) {
          const row = data[i];
          if (row && row[0] !== undefined && row[0] !== null) {
            const val = String(row[0]).trim();
            if (val && val.toLowerCase() !== 'chữ cái' && val.toLowerCase() !== 'chu cai') {
              result.push(val);
            }
          }
        }
        return result.length >= 20 ? result.slice(0, 20) : null;
      };

      const l1 = parseLettersFromSheet(sheet1);
      const l2 = parseLettersFromSheet(sheet2);
      const l3 = parseLettersFromSheet(sheet3);

      if (l1) room.roundBoards[1].letters = l1;
      if (l2) room.roundBoards[2].letters = l2;
      if (l3) room.roundBoards[3].letters = l3;

      [1, 2, 3].forEach(r => {
        room.roundBoards[r].visible = false;
        room.roundBoards[r].cellColors = Array(20).fill(r === 3 ? 'white' : 'yellow');
        room.roundBoards[r].selectedIndices = [];
      });

      io.to(joinedRoomId).emit('state:update', sanitizeRoomState(room));
      socket.emit('excel:upload_success', { message: 'Nhập đề từ Excel thành công!' });
    } catch (err) {
      console.error('Error parsing Excel:', err);
      socket.emit('excel:upload_error', { message: 'Lỗi khi đọc file Excel. Vui lòng kiểm tra định dạng file!' });
    }
  });
});

const PORT = 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
