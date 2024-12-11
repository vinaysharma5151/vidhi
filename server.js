const express = require('express');
const app = express();
app.use(express.json());
const http = require('http').createServer(app);
const { CohereClient } = require('cohere-ai');
require('dotenv').config();
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
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
    console.log('A user connected');

    // Join debate room
    socket.on('joinDebate', (debateTopic) => {
        console.log(`User joined debate: ${debateTopic}`);
        socket.join(debateTopic);
        if (!debateRooms.has(debateTopic)) {
            debateRooms.set(debateTopic, new Set());
            // Initialize team points for new debate room
            teamPoints.set(debateTopic, {
                team1: 0,
                team2: 0
            });
        }
        debateRooms.get(debateTopic).add(socket.id);
        // Send current points to new user
        socket.emit('updatePoints', teamPoints.get(debateTopic));
    });

    // Handle text messages
    socket.on('sendMessage', (data) => {
        console.log('Message received:', data);
        let pollId = null;
        const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Create poll if message is a question or answer
        if (data.isQuestion || data.isAnswer) {
            pollId = `poll-${Date.now()}`;
            data.pollId = pollId;
            polls.set(pollId, {
                text: data.text,
                type: data.isQuestion ? 'question' : 'answer',
                votes: {
                    valid: 0,
                    invalid: 0
                },
                voters: new Set(),
                author: data.username
            });
        }

        io.to(data.topic).emit('receiveMessage', {
            id: messageId,
            text: data.text,
            team: data.team,
            username: data.username,
            timestamp: new Date().toLocaleTimeString(),
            isQuestion: data.isQuestion,
            isAnswer: data.isAnswer,
            pollId: pollId
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
        console.log('User disconnected');
        // Remove user from debate rooms
        debateRooms.forEach((users, topic) => {
            if (users.has(socket.id)) {
                users.delete(socket.id);
                if (users.size === 0) {
                    debateRooms.delete(topic);
                }
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 