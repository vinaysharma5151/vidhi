const express = require('express');
const app = express();
app.use(express.json());
const http = require('http').createServer(app);
const { CohereClient } = require('cohere-ai');
require('dotenv').config();
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket']
});
const path = require('path');

app.use(express.static('public'));
app.use(express.static('dist'));

// Store active debate rooms
const debateRooms = new Map();
const polls = new Map(); // Store active polls
const messageReactions = new Map();  // Store message reactions
const teamPoints = new Map();  // Store team points for each debate room

// Initialize Cohere
const cohere = new CohereClient({
    token: process.env.COHERE_API_KEY,
});

// Function to query AI
async function queryAI(question) {
    try {
        console.log('Sending request to Cohere...');
        const response = await cohere.generate({
            model: 'command',
            prompt: `As a fact-checker, please verify or answer this: ${question}`,
            max_tokens: 150,
            temperature: 0.3,
            presence_penalty: 0,
            frequency_penalty: 0
        });

        console.log('Cohere Response:', response);
        if (!response.generations || !response.generations[0]) {
            throw new Error('Invalid response format from API');
        }
        return response.generations[0].text;
    } catch (error) {
        console.error('Error querying Cohere:', error.message);
        console.error('Full error:', error);
        return 'Error processing the fact check request. Please try again later.';
    }
}

io.on('connection', (socket) => {
    console.log('A user connected with ID:', socket.id);

    socket.on('joinDebate', (data) => {
        console.log(`User ${data.username} joined debate:`, data.topic);
        socket.join(data.topic);
        
        if (!debateRooms.has(data.topic)) {
            debateRooms.set(data.topic, new Map());
        }
        
        debateRooms.get(data.topic).set(socket.id, {
            username: data.username,
            team: data.team
        });
        
        // Notify others in the room
        socket.to(data.topic).emit('userJoined', {
            username: data.username,
            team: data.team
        });
    });

    socket.on('sendMessage', (data) => {
        console.log('Message received from', data.username, ':', data.text);
        const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Broadcast to everyone in the room including sender
        io.in(data.topic).emit('receiveMessage', {
            id: messageId,
            text: data.text,
            team: data.team,
            username: data.username,
            timestamp: new Date().toLocaleTimeString(),
            isQuestion: data.isQuestion,
            isAnswer: data.isAnswer
        });
    });

    // Handle voice recordings
    socket.on('sendVoiceMessage', (data) => {
        console.log('Voice message received from:', data.username);
        // Only emit to other users in the same room
        socket.to(data.topic).emit('receiveVoiceMessage', {
            audioUrl: data.audioUrl,
            team: data.team,
            username: data.username,
            timestamp: new Date().toLocaleTimeString()
        });
    });

    // Handle poll votes
    socket.on('votePoll', (data) => {
        const poll = polls.get(data.pollId);
        if (poll && !poll.voters.has(data.username)) {
            poll.votes[data.vote]++;
            poll.voters.add(data.username);
            
            // Update points based on valid/invalid votes
            if (data.totalVotes >= 3) {
                const validPercentage = (poll.votes.valid / (poll.votes.valid + poll.votes.invalid)) * 100;
                const points = teamPoints.get(data.topic);
                
                if (validPercentage > 50) {
                    // Award points for valid contributions
                    if (poll.type === 'question') {
                        points[poll.team] += 2;  // 2 points for good question
                    } else if (poll.type === 'answer') {
                        points[poll.team] += 3;  // 3 points for good answer
                    }
                } else {
                    // Deduct points for invalid contributions
                    points[poll.team] -= 1;
                }
                
                // Ensure points don't go negative
                points.team1 = Math.max(0, points.team1);
                points.team2 = Math.max(0, points.team2);
                
                // Broadcast updated points
                io.to(data.topic).emit('updatePoints', points);
            }
            
            io.to(data.topic).emit('pollUpdate', {
                pollId: data.pollId,
                votes: poll.votes,
                totalVotes: poll.votes.valid + poll.votes.invalid
            });
        }
    });

    // Handle fact check requests
    socket.on('checkFact', async (data) => {
        console.log('Fact check requested:', data.text);
        try {
            const response = await queryAI(data.text);
            
            socket.emit('factCheckResult', {
                original: data.text,
                result: response,
                timestamp: new Date().toLocaleTimeString()
            });
        } catch (error) {
            console.error('Error in checkFact handler:', error);
            socket.emit('factCheckResult', {
                original: data.text,
                result: 'Sorry, there was an error processing your request.',
                timestamp: new Date().toLocaleTimeString()
            });
        }
    });

    // Handle reactions
    socket.on('addReaction', (data) => {
        const { messageId, emoji, username, topic } = data;
        
        if (!messageReactions.has(messageId)) {
            messageReactions.set(messageId, new Map());
        }
        
        const messageReactionMap = messageReactions.get(messageId);
        if (!messageReactionMap.has(emoji)) {
            messageReactionMap.set(emoji, new Set());
        }
        
        const userSet = messageReactionMap.get(emoji);
        userSet.add(username);
        
        // Convert reactions to a format suitable for sending
        const reactionsObject = {};
        messageReactionMap.forEach((users, emoji) => {
            reactionsObject[emoji] = Array.from(users);
        });
        
        io.to(topic).emit('reactionUpdate', {
            messageId: messageId,
            reactions: reactionsObject
        });
    });

    // Handle disconnection and cleanup
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Clean up user from rooms
        debateRooms.forEach((users, topic) => {
            if (users.has(socket.id)) {
                const userData = users.get(socket.id);
                users.delete(socket.id);
                // Notify room that user left
                socket.to(topic).emit('userLeft', {
                    username: userData.username
                });
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 