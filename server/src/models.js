export function toBool(value) {
  return value === 1 || value === true;
}

export function authorFromRow(row) {
  return {
    id: row.author_id,
    username: row.author_username,
    display_name: row.author_display_name,
    avatar_color: row.author_avatar_color,
    verified: toBool(row.author_verified),
  };
}

export function videoFromRow(row) {
  return {
    id: row.id,
    caption: row.caption,
    url: row.url,
    poster: row.poster,
    duration: row.duration,
    width: row.width,
    height: row.height,
    created_at: row.created_at,
    author: authorFromRow(row),
    stats: {
      likes: row.likes,
      comments: row.comment_count,
      shares: row.shares,
      views: row.views,
      favorites: row.favorites,
    },
    liked: toBool(row.viewer_liked),
    favorited: toBool(row.viewer_favorited),
    following: toBool(row.viewer_following),
  };
}

export function userFromRow(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    bio: row.bio,
    avatar_color: row.avatar_color,
    verified: toBool(row.verified),
    following_count: row.following_count,
    follower_count: row.follower_count,
  };
}

export function commentFromRow(row) {
  return {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    likes: row.likes,
    liked: toBool(row.viewer_liked),
    parent_id: row.parent_id === null || row.parent_id === undefined ? null : row.parent_id,
    author: {
      id: row.author_id,
      username: row.author_username,
      display_name: row.author_display_name,
      avatar_color: row.author_avatar_color,
    },
  };
}

export function messageFromRow(row, viewerId) {
  return {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    from_me: row.sender_id === viewerId,
  };
}
