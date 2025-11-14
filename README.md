# PharaohVault Backend

Express.js backend with TypeScript, MongoDB, and JWT-based authentication.

## Features

- JWT-based cookie authentication
- User registration and login
- Password reset functionality
- Role-based access control (user/admin)
- MongoDB for data persistence
- CORS configured for frontend integration

## Prerequisites

- Node.js (v18 or higher)
- MongoDB (local or cloud instance)
- npm or yarn

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory:
```env
PORT=5000
NODE_ENV=development

MONGODB_URI=mongodb://localhost:27017/pharaohvault

JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRE=7d

FRONTEND_URL=http://localhost:3000

# Email Configuration (for password reset)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
EMAIL_FROM=noreply@pharaohvault.com
```

3. Make sure MongoDB is running:
```bash
# If using local MongoDB
mongod

# Or use MongoDB Atlas cloud instance
```

4. Run the development server:
```bash
npm run dev
```

The server will start on `http://localhost:5000` (or the port specified in `.env`).

## API Endpoints

### Authentication

- `POST /api/auth/signup` - Register a new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/logout` - Logout user
- `GET /api/auth/me` - Get current user (requires authentication)
- `POST /api/auth/forgot-password` - Send password reset email
- `POST /api/auth/reset-password` - Reset password with token

### Health Check

- `GET /api/health` - Server health check

## User Model

The User model includes:
- Email (unique, required)
- Password (hashed with bcrypt)
- First name, last name
- Phone number (optional)
- Billing address
- Shipping address
- Role (user/admin)
- Email verification status
- Password reset tokens

## Authentication Flow

1. User signs up or logs in
2. Server generates JWT token
3. Token is stored in HTTP-only cookie
4. Subsequent requests include cookie automatically
5. Middleware validates token on protected routes

## Development

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run type-check` - Type check without building

## Production

1. Set `NODE_ENV=production` in `.env`
2. Use a strong `JWT_SECRET`
3. Configure proper CORS origins
4. Use secure cookie settings (HTTPS required)
5. Build the project: `npm run build`
6. Start the server: `npm start`

## Security Notes

- Passwords are hashed using bcrypt
- JWT tokens are stored in HTTP-only cookies
- CORS is configured to only allow requests from the frontend URL
- Password reset tokens expire after 1 hour
- Use environment variables for sensitive configuration

# gold-transaction
