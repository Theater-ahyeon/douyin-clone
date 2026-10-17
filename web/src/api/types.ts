export type User = {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_color: string;
  verified: boolean;
  following_count: number;
  follower_count: number;
};

export type VideoAuthor = {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  verified?: boolean;
};

export type VideoStats = {
  likes: number;
  comments: number;
  shares: number;
  views: number;
  favorites: number;
};

export type Video = {
  id: string;
  caption: string;
  url: string;
  poster: string;
  duration: number;
  width: number;
  height: number;
  created_at: string | number;
  author: VideoAuthor;
  stats: VideoStats;
  liked: boolean;
  favorited: boolean;
  following: boolean;
};

export type Comment = {
  id: string;
  content: string;
  created_at: string | number;
  likes: number;
  liked: boolean;
  author: VideoAuthor;
  parent_id: string | null;
};

export type Message = {
  id: string;
  content: string;
  created_at: string | number;
  from_me: boolean;
};

export type Conversation = {
  peer: User;
  last: Message | null;
  unread: number;
};

export type UserStats = {
  followers: number;
  following: number;
  likes_received: number;
  videos: number;
};

export type Paged<T> = { items: T[]; next_cursor?: string | null };
export type AuthResponse = { token: string; user: User };
