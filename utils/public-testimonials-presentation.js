"use strict";

function buildPublicTestimonialsPayload(items = [], hotelSlug = "") {
  const testimonials = (Array.isArray(items) ? items : [])
    .filter(
      (item) =>
        item &&
        item.is_archived !== true &&
        item.is_active !== false &&
        item.is_approved === true
    )
    .sort((left, right) => {
      const leftSort = Number.isFinite(Number(left?.sort_order)) ? Number(left.sort_order) : 0;
      const rightSort = Number.isFinite(Number(right?.sort_order)) ? Number(right.sort_order) : 0;
      if (leftSort !== rightSort) return leftSort - rightSort;
      const leftCreated = Date.parse(left?.created_at || "") || 0;
      const rightCreated = Date.parse(right?.created_at || "") || 0;
      return rightCreated - leftCreated;
    })
    .map((item) => ({
      id: item.id,
      hotelSlug: item.hotel_slug || hotelSlug,
      name: item.guest_name || item.name || "",
      role: item.guest_role || item.role || "",
      text: item.review_text || item.text || "",
      stars: Number(item.star_rating ?? item.stars ?? 5) || 5,
      avatar: item.avatar_url || item.avatar || ""
    }))
    .filter((item) => item.name && item.text);

  return {
    success: true,
    testimonials
  };
}

module.exports = {
  buildPublicTestimonialsPayload
};
