const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// CẤU HÌNH USERNAME TIKTOK (Điền ID tài khoản đang livestream vào đây)
const TIKTOK_USERNAME = "trangnguyen_online"; // Thay bằng ID tiktok của bạn

// Ngân hàng câu hỏi
const QUESTIONS = [
  {
    q: "Vị vua nào đã ban 'Chiếu dời đô' từ Hoa Lư về Thăng Long vào năm 1010?",
    options: ["A. Lý Thái Tổ", "B. Lý Nhân Tông", "C. Lê Thái Tổ", "D. Trần Thái Tông"],
    ans: "A"
  },
  {
    q: "Trạng nguyên trẻ tuổi nhất trong lịch sử khoa bảng Việt Nam (13 tuổi) là ai?",
    options: ["A. Lê Quý Đôn", "B. Nguyễn Hiền", "C. Lương Thế Vinh", "D. Mạc Đĩnh Chi"],
    ans: "B"
  },
  {
    q: "Quốc Tử Giám - trường đại học đầu tiên của Việt Nam được thành lập năm nào?",
    options: ["A. 1010", "B. 1070", "C. 1076", "D. 1258"],
    ans: "C"
  },
  {
    q: "Danh xưng 'Trạng Lường' trong dân gian gắn liền với danh nhân khoa bảng nào?",
    options: ["A. Lương Thế Vinh", "B. Nguyễn Bỉnh Khiêm", "C. Phùng Khắc Khoan", "D. Chu Văn An"],
    ans: "A"
  },
  {
    q: "Địa danh nào gắn liền với 3 lần chiến thắng giặc ngoại xâm trên sông nước?",
    options: ["A. Sông Hồng", "B. Sông Đáy", "C. Sông Bạch Đằng", "D. Sông Như Nguyệt"],
    ans: "C"
  }
];

// Quản lý trạng thái Game
const players = new Map(); // id -> { uniqueId, nickname, avatar, score, deskIndex }
let currentQIndex = 0;
let roundTimer = 60;
let timerInterval = null;
let roundAnswers = []; // Lưu các câu trả lời: [{ userId, ans, timeTaken }]
let gameState = "IDLE"; // IDLE, QUESTION, RESULT, FINAL

function spawnPlayer(uniqueId, nickname, avatar) {
  if (!players.has(uniqueId)) {
    const newPlayer = {
      uniqueId,
      nickname: nickname || uniqueId,
      avatar: avatar || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(uniqueId),
      score: 0,
      deskIndex: players.size % 24 // Tối đa 24 bàn hiển thị trên màn hình
    };
    players.set(uniqueId, newPlayer);
    io.emit('player_joined', newPlayer);
    console.log(`[VÀO THI] Sĩ tử mới: ${newPlayer.nickname}`);
  }
  return players.get(uniqueId);
}

function startRound() {
  if (currentQIndex >= QUESTIONS.length) {
    endGame();
    return;
  }

  gameState = "QUESTION";
  roundAnswers = [];
  roundTimer = 60;

  const currentQ = QUESTIONS[currentQIndex];
  io.emit('round_start', {
    qIndex: currentQIndex + 1,
    totalQ: QUESTIONS.length,
    question: currentQ.q,
    options: currentQ.options,
    timeLimit: roundTimer
  });

  const questionStartTime = Date.now();

  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    roundTimer--;
    io.emit('timer_tick', roundTimer);

    if (roundTimer <= 0) {
      clearInterval(timerInterval);
      evaluateRound(questionStartTime);
    }
  }, 1000);
}

function evaluateRound(startTime) {
  gameState = "RESULT";
  const currentQ = QUESTIONS[currentQIndex];
  const correctAnswers = roundAnswers.filter(a => a.ans === currentQ.ans);

  // Sắp xếp người trả lời đúng theo thời gian gửi (ai gửi trước ăn điểm cao hơn)
  correctAnswers.sort((a, b) => a.timeTaken - b.timeTaken);

  let fastestPlayer = null;
  if (correctAnswers.length > 0) {
    fastestPlayer = players.get(correctAnswers[0].userId);
  }

  // Cộng điểm
  correctAnswers.forEach((record, index) => {
    const player = players.get(record.userId);
    if (player) {
      // Người nhanh nhất được 100 điểm, người thứ 2 được 80, thứ 3 được 70, các vị trí sau được 50
      let bonus = 50;
      if (index === 0) bonus = 100;
      else if (index === 1) bonus = 80;
      else if (index === 2) bonus = 70;

      player.score += bonus;
      record.awarded = bonus;
      record.nickname = player.nickname;
    }
  });

  // Bảng xếp hạng tạm thời
  const leaderboard = Array.from(players.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  io.emit('round_ended', {
    correctAnswer: currentQ.ans,
    fastestPlayer: fastestPlayer ? { nickname: fastestPlayer.nickname, time: (correctAnswers[0].timeTaken / 1000).toFixed(2) } : null,
    correctCount: correctAnswers.length,
    leaderboard
  });

  // Chờ 8 giây hiển thị kết quả rồi chuyển câu tiếp
  setTimeout(() => {
    currentQIndex++;
    startRound();
  }, 12000);
}

function endGame() {
  gameState = "FINAL";
  clearInterval(timerInterval);

  // Chọn Top 3 phong danh hiệu
  const sorted = Array.from(players.values()).sort((a, b) => b.score - a.score);
  const titles = {
    trangNguyen: sorted[0] || null, // Vị trí số 1
    bangNhan: sorted[1] || null,    // Vị trí số 2
    thamHoa: sorted[2] || null      // Vị trí số 3
  };

  io.emit('game_over', {
    titles,
    finalLeaderboard: sorted.slice(0, 10)
  });
}

// Xử lý gửi đáp án của người chơi
function handleAnswer(uniqueId, nickname, text) {
  if (gameState !== "QUESTION") return;

  const cleanText = text.trim().toUpperCase();
  // Nhận diện cú pháp "A", "B", "C", "D" hoặc "ĐÁP ÁN A"
  const match = cleanText.match(/^[A-D]$/) || cleanText.match(/^(DAP AN|CHON)\s*([A-D])$/);
  if (!match) return;

  const chosenAns = match[2] || match[0];
  const player = spawnPlayer(uniqueId, nickname);

  // Chỉ cho phép trả lời 1 lần mỗi câu
  const existing = roundAnswers.find(a => a.userId === uniqueId);
  if (!existing) {
    roundAnswers.push({
      userId: uniqueId,
      ans: chosenAns,
      timeTaken: (60 - roundTimer) * 1000
    });

    io.emit('player_answered', {
      deskIndex: player.deskIndex,
      nickname: player.nickname
    });
  }
}

// ==========================================
// KẾT NỐI VỚI TIKTOK LIVE CONNECTOR
// ==========================================
let tiktokConnection = new WebcastPushConnection(TIKTOK_USERNAME);

tiktokConnection.connect().then(state => {
  console.log(`[TIKTOK] Đã kết nối luồng Live của: ${TIKTOK_USERNAME}`);
}).catch(err => {
  console.warn(`[TIKTOK CHÚ Ý] Chưa thể kết nối live (hoặc tài khoản chưa bật live): ${err.message}`);
  console.log("-> Bật chế độ thử nghiệm nội bộ để kiểm tra giao diện qua web client.");
});

// Bắt sự kiện người xem tham gia
tiktokConnection.on('member', data => {
  spawnPlayer(data.uniqueId, data.nickname, data.profilePictureUrl);
});

// Bắt sự kiện bình luận (comment)
tiktokConnection.on('chat', data => {
  handleAnswer(data.uniqueId, data.nickname, data.comment);
});

// Bắt sự kiện tặng quà (Gift)
tiktokConnection.on('gift', data => {
  // Chỉ cảm ơn khi lượt tặng hoàn tất
  if (data.giftType === 1 && !data.repeatEnd) return;

  const player = spawnPlayer(data.uniqueId, data.nickname, data.profilePictureUrl);
  // Thưởng thêm điểm sĩ tử khi tặng quà
  const bonusPoints = (data.diamondCount || 1) * 10;
  player.score += bonusPoints;

  io.emit('gift_received', {
    nickname: data.nickname,
    avatar: data.profilePictureUrl,
    giftName: data.giftName,
    giftIcon: data.giftPictureUrl,
    repeatCount: data.repeatCount,
    bonusPoints
  });
});

// ==========================================
// SOCKET GIAO TIẾP VỚI BROWSER
// ==========================================
io.on('connection', (socket) => {
  console.log('[CLIENT] Đã kết nối màn hình hiển thị OBS/Studio.');
  
  // Gửi trạng thái danh sách sĩ tử hiện tại
  socket.emit('init_state', {
    players: Array.from(players.values()),
    gameState
  });

  // Hỗ trợ kích hoạt game từ trang quản lý hoặc phím tắt
  socket.on('start_game', () => {
    currentQIndex = 0;
    players.forEach(p => p.score = 0);
    startRound();
  });

  // Cho phép giả lập lệnh test khi không cần bật live TikTok thật
  socket.on('mock_chat', ({ name, text }) => {
    handleAnswer(name, name, text);
  });
  
  socket.on('mock_gift', ({ name, giftName }) => {
    io.emit('gift_received', {
      nickname: name,
      avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=' + name,
      giftName: giftName,
      giftIcon: '🎁',
      repeatCount: 1,
      bonusPoints: 50
    });
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server chạy tại: http://localhost:${PORT}`);
});
