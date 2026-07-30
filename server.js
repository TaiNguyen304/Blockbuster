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
app.use(express.static(__dirname));

// Default initial state
const defaultLetters = {
  1: ["B", "H", "O", "V", "Q", "Y", "E", "P", "R", "Ô", "L", "U", "N", "M", "T", "A", "G", "Ă", "I", "C"],
  2: ["D", "X", "V", "E", "K", "G", "C", "T", "Â", "Q", "R", "Ô", "I", "Ă", "Ê", "Ư", "Đ", "A", "O", "H"],
  3: ["P", "H", "U", "A", "I", "Y", "Ê", "Ơ", "T", "B", "C", "N", "L", "Ă", "O", "X", "G", "M", "Đ", "R"]
};

function createNewRoundState(letters, isRound3 = false) {
  return {
    visible: false,
    letters: [...letters],
    cellColors: Array(20).fill(isRound3 ? 'white' : 'yellow'), // 'yellow', 'blue', 'white'
    selectedIndices: []
  };
}

let gameState = {
  currentRound: 1, // 1, 2, 3
  roundBoards: {
    1: createNewRoundState(defaultLetters[1]),
    2: createNewRoundState(defaultLetters[2]),
    3: createNewRoundState(defaultLetters[3], true)
  },
  buzzer: {
    locked: true,
    pressedBy: null // 'player', 'couple', or null
  },
  timer: {
    seconds: 60,
    running: false
  }
};

let timerInterval = null;

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  gameState.timer.running = true;
  io.emit('state:update', gameState);

  timerInterval = setInterval(() => {
    if (gameState.timer.running && gameState.timer.seconds > 0) {
      gameState.timer.seconds -= 1;
      io.emit('timer:tick', { seconds: gameState.timer.seconds });
      if (gameState.timer.seconds <= 0) {
        gameState.timer.running = false;
        clearInterval(timerInterval);
        timerInterval = null;
        io.emit('state:update', gameState);
      }
    }
  }, 1000);
}

function pauseTimer() {
  gameState.timer.running = false;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  io.emit('state:update', gameState);
}

function resetTimer() {
  pauseTimer();
  gameState.timer.seconds = 60;
  io.emit('state:update', gameState);
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/controller', (req, res) => res.sendFile(path.join(__dirname, 'controller.html')));
app.get('/viewer', (req, res) => res.sendFile(path.join(__dirname, 'viewer.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'player.html')));
app.get('/couple', (req, res) => res.sendFile(path.join(__dirname, 'couple.html')));

// Socket.IO
io.on('connection', (socket) => {
  // Send current state on connection
  socket.emit('state:update', gameState);

  socket.on('get:state', () => {
    socket.emit('state:update', gameState);
  });

  // Round Switch
  socket.on('round:switch', (round) => {
    if ([1, 2, 3].includes(round)) {
      gameState.currentRound = round;
      io.emit('state:update', gameState);
    }
  });

  // Show Board (Hiện bảng)
  socket.on('board:show', (round) => {
    const r = round || gameState.currentRound;
    const letters = [...gameState.roundBoards[r].letters];
    // Randomize order for the board display
    for (let i = letters.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    gameState.roundBoards[r].letters = letters;
    gameState.roundBoards[r].visible = true;
    gameState.roundBoards[r].cellColors = Array(20).fill(r === 3 ? 'white' : 'yellow');
    gameState.roundBoards[r].selectedIndices = [];
    io.emit('state:update', gameState);
  });

  // Toggle cell select
  socket.on('board:toggle_cell_select', ({ round, index }) => {
    const r = round || gameState.currentRound;
    const board = gameState.roundBoards[r];
    if (board && index >= 0 && index < 20) {
      if (!board.selectedIndices) board.selectedIndices = [];
      const pos = board.selectedIndices.indexOf(index);
      if (pos > -1) {
        board.selectedIndices.splice(pos, 1);
      } else {
        board.selectedIndices.push(index);
      }
      io.emit('state:update', gameState);
    }
  });

  // Color cells
  socket.on('board:color_cells', ({ round, indices, color }) => {
    const r = round || gameState.currentRound;
    const board = gameState.roundBoards[r];
    if (board && Array.isArray(indices)) {
      indices.forEach(idx => {
        if (idx >= 0 && idx < 20) {
          board.cellColors[idx] = color;
        }
      });
      board.selectedIndices = [];
      io.emit('state:update', gameState);
    }
  });

  // Buzzer events
  socket.on('buzzer:control', (action) => {
    if (action === 'open') {
      gameState.buzzer.locked = false;
    } else if (action === 'lock') {
      gameState.buzzer.locked = true;
    } else if (action === 'reset_open') {
      gameState.buzzer.locked = false;
      gameState.buzzer.pressedBy = null;
    } else if (action === 'reset_lock') {
      gameState.buzzer.locked = true;
      gameState.buzzer.pressedBy = null;
    }
    io.emit('state:update', gameState);
  });

  socket.on('buzzer:press', ({ team }) => {
    if (!gameState.buzzer.locked && !gameState.buzzer.pressedBy) {
      if (team === 'player' || team === 'couple') {
        gameState.buzzer.pressedBy = team;
        gameState.buzzer.locked = true;
        io.emit('state:update', gameState);
        io.emit('buzzer:alert', { team });
      }
    }
  });

  // Timer events
  socket.on('timer:control', (action) => {
    if (action === 'start') {
      if (gameState.timer.seconds <= 0) gameState.timer.seconds = 60;
      startTimer();
    } else if (action === 'pause') {
      pauseTimer();
    } else if (action === 'continue') {
      if (gameState.timer.seconds > 0) startTimer();
    } else if (action === 'reset') {
      resetTimer();
    }
  });

  // Excel Upload
  socket.on('excel:upload', (base64Data) => {
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

      if (l1) gameState.roundBoards[1].letters = l1;
      if (l2) gameState.roundBoards[2].letters = l2;
      if (l3) gameState.roundBoards[3].letters = l3;

      [1, 2, 3].forEach(r => {
        gameState.roundBoards[r].visible = false;
        gameState.roundBoards[r].cellColors = Array(20).fill(r === 3 ? 'white' : 'yellow');
        gameState.roundBoards[r].selectedIndices = [];
      });

      io.emit('state:update', gameState);
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
