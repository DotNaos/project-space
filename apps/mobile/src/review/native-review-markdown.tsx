import { Text, View } from 'react-native';

export function NativeReviewMarkdown({
  color,
  text,
}: {
  color: string;
  text: string;
}) {
  return (
    <View className="gap-2">
      {text
        .trim()
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((paragraph, index) => (
          <Text
            key={`${index}-${paragraph.slice(0, 20)}`}
            selectable
            style={{ color, fontSize: 15, lineHeight: 23 }}
          >
            {inlineMarkdown(paragraph)}
          </Text>
        ))}
    </View>
  );
}

function inlineMarkdown(value: string) {
  const parts = value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <Text key={index} style={{ fontWeight: '700' }}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <Text
          key={index}
          style={{
            backgroundColor: 'rgba(127,127,127,0.18)',
            fontFamily: 'Courier',
          }}
        >
          {part.slice(1, -1)}
        </Text>
      );
    }
    return part;
  });
}
