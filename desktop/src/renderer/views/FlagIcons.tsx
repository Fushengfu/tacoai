import React from 'react'

/** 中国国旗 SVG，viewBox 0 0 30 20 */
export const FlagCN: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 30 20" aria-hidden="true" {...props}>
    <rect width="30" height="20" fill="#DE2910" />
    <polygon
      points="7,3 7.7,5.3 10.1,5.3 8.2,6.8 9,9.1 7,7.6 5,9.1 5.8,6.8 3.9,5.3 6.3,5.3"
      fill="#FFDE00"
    />
    <polygon
      points="13.5,5 13.9,6.5 15.3,6.5 14.1,7.5 14.6,9 13.5,8 12.4,9 12.9,7.5 11.7,6.5 13.1,6.5"
      fill="#FFDE00"
      transform="scale(0.45) translate(17,5)"
    />
    <polygon
      points="13.3,2 13.7,3.5 15.1,3.5 13.9,4.5 14.4,6 13.3,5 12.2,6 12.7,4.5 11.5,3.5 12.9,3.5"
      fill="#FFDE00"
      transform="scale(0.45) translate(19,3)"
    />
    <polygon
      points="11,4 11.4,5.5 12.8,5.5 11.6,6.5 12.1,8 11,7 9.9,8 10.4,6.5 9.2,5.5 10.6,5.5"
      fill="#FFDE00"
      transform="scale(0.45) translate(17.5,8)"
    />
    <polygon
      points="9.2,6.2 9.6,7.7 11,7.7 9.8,8.7 10.3,10.2 9.2,9.2 8.1,10.2 8.6,8.7 7.4,7.7 8.8,7.7"
      fill="#FFDE00"
      transform="scale(0.45) translate(14,10)"
    />
  </svg>
)

/** 美国国旗 SVG，viewBox 0 0 30 20 */
export const FlagUS: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 30 20" aria-hidden="true" {...props}>
    <defs>
      <clipPath id="us-flag-canton">
        <rect x="0" y="0" width="12" height="10.8" />
      </clipPath>
    </defs>
    <rect width="30" height="20" fill="#FFFFFF" />
    <rect y="0" width="30" height="1.54" fill="#B22234" />
    <rect y="3.08" width="30" height="1.54" fill="#B22234" />
    <rect y="6.16" width="30" height="1.54" fill="#B22234" />
    <rect y="9.24" width="30" height="1.54" fill="#B22234" />
    <rect y="12.32" width="30" height="1.54" fill="#B22234" />
    <rect y="15.4" width="30" height="1.54" fill="#B22234" />
    <rect y="18.48" width="30" height="1.52" fill="#B22234" />
    <rect width="12" height="10.8" fill="#3C3B6E" />
    <g clipPath="url(#us-flag-canton)">
      <circle cx="3" cy="2.7" r="0.7" fill="#FFFFFF" />
      <circle cx="9" cy="2.7" r="0.7" fill="#FFFFFF" />
      <circle cx="6" cy="5.4" r="0.7" fill="#FFFFFF" />
      <circle cx="3" cy="8.1" r="0.7" fill="#FFFFFF" />
      <circle cx="9" cy="8.1" r="0.7" fill="#FFFFFF" />
    </g>
  </svg>
)
