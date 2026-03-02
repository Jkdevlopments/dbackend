const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: "http://localhost:3000",
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// JWT Secret
const JWT_SECRET = 'your-secret-key-change-this';

// PostgreSQL Connection
/*const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'chatapp',
  password: '1234',
  port: 5432,
});*/
const pool = new Pool({
  user: "postgresl",   // your Render DB user
  host: "dpg-d6in4psr85hc73a6bmn0-a.singapore-postgres.render.com",
  database: "chatapp_jfjl",
  password: "8P1wX6tzlBwZaJW6DCjNEhA1OMvfmDiT", 
  port: 5432,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to database:', err.stack);
  } else {
    console.log('✅ Connected to PostgreSQL');
    release();
  }
});

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// FastAPI endpoint
const FASTAPI_URL = 'http://localhost:8000';

// ================= SOCKET.IO =================
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('join', (userId) => {
    socket.join(`user_${userId}`);
    // Update user online status
    pool.query(
      'UPDATE users SET is_online = true, last_seen = CURRENT_TIMESTAMP WHERE id = $1',
      [userId]
    ).catch(err => console.error('Error updating online status:', err));
    
    // Broadcast to all users that this user is online
    socket.broadcast.emit('userOnline', { userId, isOnline: true });
    
    console.log(`User ${userId} joined room user_${userId}`);
  });

  socket.on('sendMessage', async (data) => {
    try {
      console.log('📤 Sending message:', data);
      
      // Save message to database
      const result = await pool.query(
        `INSERT INTO messages (sender_id, receiver_id, message, file_url, file_type, file_name, analysis_result) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [data.senderId, data.receiverId, data.message, data.fileUrl, data.fileType, data.fileName, data.analysis ? JSON.stringify(data.analysis) : null]
      );
      
      const savedMessage = result.rows[0];
      console.log('✅ Message saved to DB:', savedMessage.id);
      
      // Update or create chat
      const user1Id = Math.min(parseInt(data.senderId), parseInt(data.receiverId));
      const user2Id = Math.max(parseInt(data.senderId), parseInt(data.receiverId));
      
      await pool.query(
        `INSERT INTO chats (user1_id, user2_id, last_message_id) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (user1_id, user2_id) 
         DO UPDATE SET last_message_id = $3, updated_at = CURRENT_TIMESTAMP`,
        [user1Id, user2Id, savedMessage.id]
      );

      // Prepare message to send
      const messageToSend = {
        id: savedMessage.id,
        senderId: data.senderId,
        receiverId: data.receiverId,
        message: data.message,
        fileUrl: data.fileUrl,
        fileType: data.fileType,
        fileName: data.fileName,
        analysis: data.analysis,
        timestamp: savedMessage.created_at
      };

      // Emit to receiver
      io.to(`user_${data.receiverId}`).emit('receiveMessage', messageToSend);
      console.log(`📨 Message sent to user_${data.receiverId}`);
      
      // Also emit back to sender for confirmation
      socket.emit('messageSent', messageToSend);
      
    } catch (error) {
      console.error('❌ Error saving message:', error);
    }
  });

  socket.on('typing', (data) => {
    socket.to(`user_${data.receiverId}`).emit('userTyping', {
      userId: data.senderId,
      isTyping: data.isTyping
    });
  });

  // ================= CALL SIGNALING =================
  
  // Start a call
  socket.on('startCall', (data) => {
    console.log(`📞 Call started from ${data.from} to ${data.targetId}`);
    io.to(`user_${data.targetId}`).emit('incomingCall', {
      from: data.from,
      fromName: data.fromName,
      type: data.type,
      offer: data.offer
    });
  });

  // Accept a call
  socket.on('acceptCall', (data) => {
    console.log(`📞 Call accepted, sending answer to ${data.targetId}`);
    io.to(`user_${data.targetId}`).emit('callAccepted', {
      answer: data.answer
    });
  });

  // Reject a call
  socket.on('rejectCall', (data) => {
    console.log(`📞 Call rejected by ${data.fromName}, notifying ${data.targetId}`);
    io.to(`user_${data.targetId}`).emit('callRejected', {
      fromName: data.fromName
    });
  });

  // End a call
  socket.on('endCall', (data) => {
    console.log(`📞 Call ended, notifying ${data.targetId}`);
    io.to(`user_${data.targetId}`).emit('callEnded');
  });

  // ICE candidate exchange
  socket.on('iceCandidate', (data) => {
    console.log(`📞 ICE candidate sent to ${data.targetId}`);
    io.to(`user_${data.targetId}`).emit('iceCandidate', {
      candidate: data.candidate
    });
  });

  // Call missed (when receiver doesn't answer)
  socket.on('callMissed', (data) => {
    console.log(`📞 Call missed, notifying ${data.targetId}`);
    io.to(`user_${data.targetId}`).emit('callMissed', {
      fromName: data.fromName
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ================= AUTH ROUTES =================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    console.log('Registration attempt:', { username, email });
    
    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    // Check if user exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, is_online) 
       VALUES ($1, $2, $3, true) RETURNING id, username, email, is_online, created_at`,
      [username, email, hashedPassword]
    );
    
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    
    console.log('✅ User registered:', user.username);
    
    res.json({ 
      success: true,
      user, 
      token 
    });
  } catch (error) {
    console.error('❌ Registration error:', error);
    res.status(500).json({ error: 'Registration failed: ' + error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    
    // Update user online status
    await pool.query(
      'UPDATE users SET is_online = true, last_seen = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );
    
    // Remove password hash from response
    delete user.password_hash;
    
    console.log('✅ User logged in:', user.username);
    
    res.json({ 
      success: true,
      user, 
      token 
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/verify-token', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.json({ valid: false });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if user still exists
    const user = await pool.query(
      'SELECT id FROM users WHERE id = $1',
      [decoded.id]
    );
    
    if (user.rows.length === 0) {
      return res.json({ valid: false });
    }
    
    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.json({ valid: false });
  }
});

// ================= USER ROUTES =================
// Get ALL users except current user
app.get('/api/users/all/:currentUserId', async (req, res) => {
  try {
    const { currentUserId } = req.params;
    
    console.log(`📋 Fetching all users except: ${currentUserId}`);
    
    const result = await pool.query(
      `SELECT id, username, email, profile_pic, status, is_online, last_seen 
       FROM users 
       WHERE id != $1
       ORDER BY username ASC`,
      [currentUserId]
    );
    
    console.log(`📊 Found ${result.rows.length} users`);
    
    res.json({ 
      success: true,
      users: result.rows 
    });
  } catch (error) {
    console.error('❌ Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get last message between two users
app.get('/api/messages/last/:userId1/:userId2', async (req, res) => {
  try {
    const { userId1, userId2 } = req.params;
    
    const result = await pool.query(
      `SELECT message as "lastMessage", created_at as "timestamp", analysis_result
       FROM messages 
       WHERE (sender_id = $1 AND receiver_id = $2) 
          OR (sender_id = $2 AND receiver_id = $1)
       ORDER BY created_at DESC 
       LIMIT 1`,
      [userId1, userId2]
    );
    
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.json({ lastMessage: null, timestamp: null });
    }
  } catch (error) {
    console.error('Error fetching last message:', error);
    res.status(500).json({ error: 'Failed to fetch last message' });
  }
});

// Get messages between two users
app.get('/api/messages/:userId1/:userId2', async (req, res) => {
  try {
    const { userId1, userId2 } = req.params;
    
    console.log(`📨 Fetching messages between ${userId1} and ${userId2}`);
    
    const result = await pool.query(
      `SELECT * FROM messages 
       WHERE (sender_id = $1 AND receiver_id = $2) 
          OR (sender_id = $2 AND receiver_id = $1)
       ORDER BY created_at ASC`,
      [userId1, userId2]
    );
    
    console.log(`📊 Found ${result.rows.length} messages`);
    
    res.json({ 
      success: true,
      messages: result.rows 
    });
  } catch (error) {
    console.error('❌ Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Create or get chat
app.post('/api/chats/create', async (req, res) => {
  try {
    const { userId1, userId2 } = req.body;
    
    const user1Id = Math.min(parseInt(userId1), parseInt(userId2));
    const user2Id = Math.max(parseInt(userId1), parseInt(userId2));
    
    // Check if chat exists
    let chat = await pool.query(
      `SELECT * FROM chats WHERE user1_id = $1 AND user2_id = $2`,
      [user1Id, user2Id]
    );
    
    if (chat.rows.length === 0) {
      // Create new chat
      chat = await pool.query(
        `INSERT INTO chats (user1_id, user2_id) 
         VALUES ($1, $2) RETURNING *`,
        [user1Id, user2Id]
      );
      console.log('✅ Created new chat');
    }
    
    res.json({ success: true, chat: chat.rows[0] });
  } catch (error) {
    console.error('❌ Error creating chat:', error);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

// ================= DEEPFAKE ANALYSIS WITH FASTAPI =================
app.post('/api/analyze-media', upload.single('file'), async (req, res) => {
  try {
    const { senderId, receiverId } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('🔬 Sending file to FastAPI for analysis:', file.originalname);

    // Forward to FastAPI for analysis
    const formData = new FormData();
    formData.append('file', fs.createReadStream(file.path));

    const analysisResponse = await axios.post(`${FASTAPI_URL}/analyze`, formData, {
      headers: {
        ...formData.getHeaders(),
      },
      timeout: 30000 // 30 second timeout for analysis
    });

    const analysisResult = analysisResponse.data;
    console.log('✅ FastAPI analysis complete:', analysisResult);

    // Move file to permanent storage
    const fileUrl = `http://localhost:5000/uploads/${file.filename}`;

    // Save message with analysis to database
    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, message, file_url, file_type, file_name, analysis_result) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [senderId, receiverId, '', fileUrl, file.mimetype, file.originalname, JSON.stringify(analysisResult)]
    );

    const savedMessage = result.rows[0];

    // Update or create chat
    const user1Id = Math.min(parseInt(senderId), parseInt(receiverId));
    const user2Id = Math.max(parseInt(senderId), parseInt(receiverId));
    
    await pool.query(
      `INSERT INTO chats (user1_id, user2_id, last_message_id) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (user1_id, user2_id) 
       DO UPDATE SET last_message_id = $3, updated_at = CURRENT_TIMESTAMP`,
      [user1Id, user2Id, savedMessage.id]
    );

    // Prepare message to send
    const messageToSend = {
      id: savedMessage.id,
      senderId: senderId,
      receiverId: receiverId,
      message: '',
      fileUrl: fileUrl,
      fileType: file.mimetype,
      fileName: file.originalname,
      analysis: analysisResult,
      timestamp: savedMessage.created_at
    };

    // Emit to receiver
    io.to(`user_${receiverId}`).emit('receiveMessage', messageToSend);
    console.log(`📨 Analyzed media sent to user_${receiverId}`);

    // Send response back to sender
    res.json({
      success: true,
      message: messageToSend,
      analysis: analysisResult
    });

  } catch (error) {
    console.error('❌ Analysis error:', error);
    
    // If FastAPI fails, still save the file but without analysis
    if (req.file) {
      try {
        const fileUrl = `http://localhost:5000/uploads/${req.file.filename}`;
        const result = await pool.query(
          `INSERT INTO messages (sender_id, receiver_id, message, file_url, file_type, file_name) 
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [req.body.senderId, req.body.receiverId, '', fileUrl, req.file.mimetype, req.file.originalname]
        );
        
        const messageToSend = {
          id: result.rows[0].id,
          senderId: req.body.senderId,
          receiverId: req.body.receiverId,
          message: '',
          fileUrl: fileUrl,
          fileType: req.file.mimetype,
          fileName: req.file.originalname,
          analysis: null,
          timestamp: result.rows[0].created_at
        };
        
        io.to(`user_${req.body.receiverId}`).emit('receiveMessage', messageToSend);
        
        return res.json({
          success: true,
          message: messageToSend,
          analysis: null,
          warning: 'Deepfake analysis unavailable'
        });
      } catch (dbError) {
        console.error('❌ Database error after FastAPI failure:', dbError);
      }
    }
    
    res.status(500).json({ error: 'Failed to analyze media' });
  }
});

// Get message with analysis
app.get('/api/messages/with-analysis/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM messages WHERE id = $1',
      [messageId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    res.json({
      success: true,
      message: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching message:', error);
    res.status(500).json({ error: 'Failed to fetch message' });
  }
});

// ================= UPLOAD ROUTES =================
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { senderId, receiverId } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileUrl = `http://localhost:5000/uploads/${file.filename}`;

    console.log('📎 File uploaded:', file.originalname);

    res.json({
      success: true,
      fileUrl: fileUrl,
      fileName: file.originalname,
      fileType: file.mimetype
    });

  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// ================= LOGOUT =================
app.post('/api/logout', async (req, res) => {
  try {
    const { userId } = req.body;
    
    await pool.query(
      'UPDATE users SET is_online = false WHERE id = $1',
      [userId]
    );
    
    // Broadcast offline status
    io.emit('userOnline', { userId, isOnline: false });
    
    console.log(`User ${userId} logged out`);
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ================= TEST ENDPOINT =================
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is running!' });
});

// ================= CHECK FASTAPI HEALTH =================
app.get('/api/analyzer/health', async (req, res) => {
  try {
    const response = await axios.get(`${FASTAPI_URL}/health`);
    res.json({ status: 'connected', ...response.data });
  } catch (error) {
    res.json({ status: 'disconnected', error: error.message });
  }
});

// ================= START SERVER =================
const PORT = 5000;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket ready`);
  console.log(`📊 Database: chatapp`);
  console.log(`🔬 FastAPI URL: ${FASTAPI_URL}`);
});