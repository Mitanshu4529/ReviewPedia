import mongoose from 'mongoose';

const MediaSchema = new mongoose.Schema({
  type: { type: String, default: 'image' },
  url: { type: String },
  size: { type: Number, default: 0 }
}, { _id: false });

const ReviewSchema = new mongoose.Schema({
  product: {
    name: { type: String, required: true },
    brand: { type: String },
    category: { type: String },
    purchaseLink: { type: String, default: '' },
    purchaseType: { type: String, default: 'online' },
    purchaseMeta: {
      title: { type: String, default: '' },
      description: { type: String, default: '' },
      image: { type: String, default: '' },
      siteName: { type: String, default: '' },
      url: { type: String, default: '' }
    }
  },
  review: {
    title: { type: String },
    text: { type: String },
    rating: { type: Number, required: true },
    media: [MediaSchema]
  },
  user: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: { type: String }
  },
  source: {
    platform: { type: String },
    isScraped: { type: Boolean, default: false }
  },
  location: {
    city: { type: String },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    // 'approximate': lat/lng were rounded to ~1 km before being stored.
    // Absent on reviews created before the reviewer could choose.
    precision: { type: String, enum: ['exact', 'approximate'] },
    h3Index: { type: String, required: true }
  },
  metadata: {
    date: { type: String }
  },
  analytics: {
    sentimentScore: { type: Number, default: 0 },
    trustScore: { type: Number, default: 0 },
    demandSignals: { type: Number, default: 0 }
  },
  likes: { type: [String], default: [] }
});

ReviewSchema.index({ "product.name": "text", "product.brand": "text", "review.text": "text", "review.title": "text", "location.city": "text" });
// The trailing _id serves the newest-first paging of one map marker / one author.
ReviewSchema.index({ "location.h3Index": 1, _id: -1 });
ReviewSchema.index({ "location.city": 1 });
ReviewSchema.index({ "product.name": 1, "analytics.sentimentScore": 1 });
ReviewSchema.index({ "product.category": 1 });
ReviewSchema.index({ "user.id": 1, _id: -1 });
// Map statistics group every review by coordinate.
ReviewSchema.index({ "location.lat": 1, "location.lng": 1 });

const Review = mongoose.model('Review', ReviewSchema);
export default Review;
