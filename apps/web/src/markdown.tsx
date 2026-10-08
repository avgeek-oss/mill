import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: () => null,
        }}
        urlTransform={(url) =>
          /^(https?:\/\/|mailto:|\/[^/]|#)/i.test(url) ? url : ""
        }
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
